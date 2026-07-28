const DEFAULT_GUIDANCE_MESSAGE = 'Gracias por escribirnos. Este canal atiende únicamente solicitudes de analistas. Si eres candidato o candidata, utiliza el formulario de atención para candidatos o comunícate con la empresa responsable de tu proceso.';

function buildCandidateGuidance(settings = {}) {
  const configuredMessage = typeof settings.message === 'string' ? settings.message.trim() : '';
  const message = configuredMessage || DEFAULT_GUIDANCE_MESSAGE;
  const rawUrl = typeof settings.formUrl === 'string' ? settings.formUrl.trim() : '';

  if (!rawUrl) return message;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return message;
    return `${message}\n\nFormulario: ${url.href}`;
  } catch (_) {
    return message;
  }
}

async function sendCandidateGuidanceIfAllowed({ db, message, chatId }) {
  const settings = await db.getCandidateSupportSettings();
  const token = await db.claimCandidateGuidance(chatId);
  if (!token) return false;
  try {
    await message.reply(buildCandidateGuidance(settings));
  } catch (error) {
    try {
      await db.releaseCandidateGuidance(chatId, token);
    } catch (releaseError) {
      console.warn('⚠️ Candidate guidance reservation could not be released:', releaseError.message);
    }
    throw error;
  }

  // At-most-once bias: after an externally successful reply, an uncertain
  // finalize must retain the claim so stale recovery suppresses duplicates.
  const finalized = await db.finalizeCandidateGuidance(chatId, token);
  if (!finalized) {
    const error = new Error('Candidate guidance finalize was not confirmed.');
    error.code = 'CANDIDATE_GUIDANCE_FINALIZE_UNCONFIRMED';
    throw error;
  }
  return true;
}

module.exports = {
  DEFAULT_GUIDANCE_MESSAGE,
  buildCandidateGuidance,
  sendCandidateGuidanceIfAllowed,
};
