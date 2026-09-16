/**
 * Google Forms -> Sistema PQR
 *
 * 1. Cambia API_URL por la URL publica HTTPS de tu API.
 * 2. Usa el mismo secreto en GOOGLE_FORMS_SECRET de tu servidor.
 * 3. En Google Sheets: Extensiones > Apps Script.
 * 4. Pega este archivo y crea un activador para onFormSubmit:
 *    Activadores > Anadir activador > onFormSubmit > Desde hoja de calculo > Al enviar formulario.
 */
const API_URL = 'https://TU-DOMINIO.com/api/v1/integrations/google-forms';
const API_SECRET = 'CAMBIA_ESTE_SECRETO_LARGO';

function onFormSubmit(event) {
  const values = event.namedValues || {};
  const responseId = event.response && event.response.getId
    ? event.response.getId()
    : `${event.range.getSheet().getName()}-${event.range.getRow()}`;

  const payload = {
    externalId: responseId,
    tipoDocumento: getValue(values, ['Tipo de documento', 'Tipo de documento *']),
    numeroDocumento: getValue(values, ['Numero de documento', 'Número de documento', 'Número de documento *']),
    nombreCompleto: getValue(values, ['Nombre completo', 'Nombre completo *']),
    correoElectronico: getValue(values, ['Correo electrónico', 'Correo electronico', 'Correo electrónico *']),
    tipoSolicitud: normalizeRequestType(getValue(values, ['Tipo de solicitud', 'Tipo de solicitud *'])),
    asunto: getValue(values, ['Asunto', 'Asunto *']),
    descripcion: getValue(values, ['Descripción detallada', 'Descripcion detallada', 'Descripción detallada *']),
  };

  const response = UrlFetchApp.fetch(API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-google-forms-secret': API_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error(`La API PQR respondio ${status}: ${response.getContentText()}`);
  }

  Logger.log(response.getContentText());
}

function getValue(namedValues, possibleNames) {
  for (const name of possibleNames) {
    if (namedValues[name] && namedValues[name][0]) return namedValues[name][0].trim();
  }
  return '';
}

function normalizeRequestType(value) {
  const normalized = value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const types = {
    peticion: 'Peticion',
    queja: 'Queja',
    reclamo: 'Reclamo',
    sugerencia: 'Sugerencia',
  };
  return types[normalized] || value.trim();
}
