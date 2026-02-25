const { MSG_TYPES } = require('../shared/constants');

function normalizeValues(obj) {
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(normalizeValues);
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      if (value === 'True' || value === 'true') {
        result[key] = true;
      } else if (value === 'False' || value === 'false') {
        result[key] = false;
      } else if (value !== '' && !isNaN(value) && !isNaN(parseFloat(value))) {
        result[key] = Number(value);
      } else {
        result[key] = value;
      }
    } else if (typeof value === 'object') {
      result[key] = normalizeValues(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function identifyMessageType(parsed) {
  if (parsed.CA_MSG) return { type: MSG_TYPES.CA_MSG, data: parsed.CA_MSG };
  if (parsed.CB_MSG) return { type: MSG_TYPES.CB_MSG, data: parsed.CB_MSG };
  if (parsed.CC_MSG) return { type: MSG_TYPES.CC_MSG, data: parsed.CC_MSG };
  if (parsed.SG_MSG) return { type: MSG_TYPES.SG_MSG, data: parsed.SG_MSG };
  if (parsed.clock_msg) return { type: MSG_TYPES.CLOCK_MSG, data: parsed.clock_msg };
  if (parsed.train_location) return { type: MSG_TYPES.TRAIN_LOCATION, data: parsed.train_location };
  if (parsed.train_delay) return { type: MSG_TYPES.TRAIN_DELAY, data: parsed.train_delay };
  return { type: 'unknown', data: parsed };
}

function parseMessage(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const normalized = normalizeValues(parsed);
    return identifyMessageType(normalized);
  } catch (err) {
    return { type: 'error', data: { raw: rawBody, error: err.message } };
  }
}

function parseSnapshotBody(rawBody) {
  // SimSig snapshots have duplicate top-level keys which JSON.parse silently overwrites.
  // Split on }{ boundaries and parse each fragment individually.
  const messages = [];
  const fragments = rawBody.replace(/\}\s*\{/g, '}|||{').split('|||');

  for (const fragment of fragments) {
    try {
      const parsed = JSON.parse(fragment);
      const normalized = normalizeValues(parsed);
      messages.push(identifyMessageType(normalized));
    } catch (err) {
      messages.push({ type: 'error', data: { raw: fragment, error: err.message } });
    }
  }
  return messages;
}

module.exports = { parseMessage, parseSnapshotBody, normalizeValues };
