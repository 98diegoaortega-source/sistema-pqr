const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const tickets = new Map();
const sessions = new Map();
const sessionDuration = 8 * 60 * 60 * 1000;
const googleFormsSecret = process.env.GOOGLE_FORMS_SECRET || '';

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const requiredFields = [
  'tipoDocumento',
  'numeroDocumento',
  'nombreCompleto',
  'correoElectronico',
  'tipoSolicitud',
  'asunto',
  'descripcion',
];

const validDocumentTypes = [
  'Cedula de Ciudadania',
  'Cedula de Extranjeria',
  'NIT',
  'Pasaporte',
];

const validRequestTypes = ['Peticion', 'Queja', 'Reclamo', 'Sugerencia'];
const validTicketStatuses = ['Registrada', 'En revision', 'Pendiente', 'Resuelta', 'Cerrada'];

function getAdminUsers() {
  try {
    const users = JSON.parse(process.env.ADMIN_USERS_JSON || '[]');
    return Array.isArray(users) ? users.filter((user) => user.username && user.password) : [];
  } catch (_error) {
    return [];
  }
}

function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((cookie) => {
    const [name, ...value] = cookie.trim().split('=');
    return [name, decodeURIComponent(value.join('='))];
  }));
}

function getSessionUser(req) {
  const token = getCookies(req).pqr_admin_session;
  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }

  return session.user;
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ mensaje: 'Debes iniciar sesion como administrador.' });
  req.admin = user;
  return next();
}

function requireManager(req, res, next) {
  if (req.admin.role !== 'admin' && req.admin.role !== 'gestor') {
    return res.status(403).json({ mensaje: 'Tu usuario no tiene permiso para gestionar tickets.' });
  }
  return next();
}

function isGoogleFormsAuthorized(req) {
  return googleFormsSecret && req.get('x-google-forms-secret') === googleFormsSecret;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createRadicado() {
  let radicado;

  do {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    radicado = `PQR-${suffix}`;
  } while (tickets.has(radicado));

  return radicado;
}

function validateTicket(body) {
  const errors = {};
  const data = {};

  requiredFields.forEach((field) => {
    data[field] = clean(body[field]);
    if (!data[field]) {
      errors[field] = 'Este campo es obligatorio.';
    }
  });

  if (data.tipoDocumento && !validDocumentTypes.includes(data.tipoDocumento)) {
    errors.tipoDocumento = 'Selecciona un tipo de documento valido.';
  }

  if (data.tipoSolicitud && !validRequestTypes.includes(data.tipoSolicitud)) {
    errors.tipoSolicitud = 'Selecciona un tipo de solicitud valido.';
  }

  if (data.correoElectronico && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.correoElectronico)) {
    errors.correoElectronico = 'Ingresa un correo electronico valido.';
  }

  if (!body.habeasData) {
    errors.habeasData = 'Debes autorizar el tratamiento de tus datos personales.';
  }

  return { data, errors };
}

app.post('/api/v1/admin/login', (req, res) => {
  const username = clean(req.body && req.body.username);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const user = getAdminUsers().find((candidate) => candidate.username === username && candidate.password === password);

  if (!user) return res.status(401).json({ mensaje: 'Usuario o contraseña incorrectos.' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    user: { username: user.username, role: user.role || 'gestor' },
    expiresAt: Date.now() + sessionDuration,
  });
  res.setHeader('Set-Cookie', `pqr_admin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDuration / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return res.json({ usuario: { username: user.username, role: user.role || 'gestor' } });
});

app.post('/api/v1/admin/logout', (req, res) => {
  const token = getCookies(req).pqr_admin_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'pqr_admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return res.json({ mensaje: 'Sesion cerrada.' });
});

app.get('/api/v1/admin/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ autenticado: false });
  return res.json({ autenticado: true, usuario: user });
});

app.post('/api/v1/tickets', (req, res) => {
  const { data, errors } = validateTicket(req.body || {});

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      mensaje: 'Revisa los campos obligatorios del formulario.',
      errores: errors,
    });
  }

  const ticket = {
    radicado: createRadicado(),
    ...data,
    habeasData: true,
    estado: 'Registrada',
    slaDias: data.tipoSolicitud === 'Queja' || data.tipoSolicitud === 'Reclamo' ? 15 : 5,
    fechaCreacion: new Date().toISOString(),
  };

  tickets.set(ticket.radicado, ticket);

  return res.status(201).json({
    mensaje: 'La PQR fue registrada correctamente.',
    radicado: ticket.radicado,
  });
});

app.post('/api/v1/integrations/google-forms', (req, res) => {
  if (!isGoogleFormsAuthorized(req)) {
    return res.status(401).json({ mensaje: 'Integracion no autorizada.' });
  }

  const body = req.body || {};
  const { data, errors } = validateTicket({ ...body, habeasData: true });
  if (body.externalId) {
    const existingTicket = Array.from(tickets.values()).find((ticket) => ticket.externalId === body.externalId);
    if (existingTicket) {
      return res.status(200).json({
        mensaje: 'La respuesta ya estaba sincronizada.',
        radicado: existingTicket.radicado,
      });
    }
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ mensaje: 'La respuesta de Google Forms tiene datos incompletos.', errores: errors });
  }

  const ticket = {
    radicado: createRadicado(),
    ...data,
    externalId: clean(body.externalId),
    habeasData: true,
    estado: 'Registrada',
    slaDias: data.tipoSolicitud === 'Queja' || data.tipoSolicitud === 'Reclamo' ? 15 : 5,
    fechaCreacion: new Date().toISOString(),
  };
  tickets.set(ticket.radicado, ticket);
  return res.status(201).json({ mensaje: 'Respuesta sincronizada correctamente.', radicado: ticket.radicado });
});

app.get('/api/v1/tickets', requireAdmin, (_req, res) => {
  const items = Array.from(tickets.values()).sort((first, second) => (
    second.fechaCreacion.localeCompare(first.fechaCreacion)
  ));

  return res.json({ tickets: items, total: items.length });
});

app.patch('/api/v1/tickets/:radicado', requireAdmin, requireManager, (req, res) => {
  const radicado = clean(req.params.radicado).toUpperCase();
  const ticket = tickets.get(radicado);

  if (!ticket) {
    return res.status(404).json({ mensaje: 'No se encontro una PQR con ese radicado.' });
  }

  const estado = clean(req.body && req.body.estado);
  const respuesta = clean(req.body && req.body.respuesta);
  if (!validTicketStatuses.includes(estado)) {
    return res.status(400).json({
      mensaje: 'El estado indicado no es valido.',
      estadosValidos: validTicketStatuses,
    });
  }

  ticket.estado = estado;
  if (respuesta) ticket.respuesta = respuesta;
  ticket.fechaActualizacion = new Date().toISOString();

  return res.json({ mensaje: 'El estado del ticket fue actualizado.', ticket });
});

app.get('/api/v1/tickets/buscar', (req, res) => {
  const radicado = clean(req.query.radicado).toUpperCase();

  if (!radicado) {
    return res.status(400).json({
      mensaje: 'Debes indicar el radicado que deseas consultar.',
    });
  }

  const ticket = tickets.get(radicado);

  if (!ticket) {
    return res.status(404).json({
      mensaje: 'No se encontro una PQR con ese radicado.',
    });
  }

  return res.json({ ticket: { radicado: ticket.radicado, estado: ticket.estado, asunto: ticket.asunto, respuesta: ticket.respuesta || '' } });
});

app.get('/api/v1/health', (_req, res) => {
  res.json({ estado: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Servidor PQR ejecutandose en http://localhost:${PORT}`);
});
