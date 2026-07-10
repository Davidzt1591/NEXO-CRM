const { validateWhatsAppMedia } = require('./mediaValidation');

async function uploadWhatsAppMediaForTicket({ ticketId, media, db = require('../database/db'), sf = require('./salesforce') }) {
  const validated = validateWhatsAppMedia(media);
  const ticket = await db.getTicketById(ticketId);
  if (!ticket?.sf_case_id) {
    return { uploaded: false, reason: 'missing_sf_case', metadata: publicMetadata(validated) };
  }

  const uploaded = await sf.uploadFileToCase(ticket.sf_case_id, validated);
  if (!uploaded.contentDocumentId) throw new Error('Salesforce no retornó ContentDocumentId para el adjunto.');
  const attachment = await db.createSalesforceAttachment({
    ticket_id: ticketId,
    sf_content_document_id: uploaded.contentDocumentId,
    filename: validated.filename,
    mimetype: validated.mimetype,
    size_bytes: validated.sizeBytes,
  });

  return {
    uploaded: true,
    attachment,
    contentDocumentId: uploaded.contentDocumentId,
    metadata: publicMetadata(validated),
  };
}

function publicMetadata(validated) {
  return {
    filename: validated.filename,
    mimetype: validated.mimetype,
    sizeBytes: validated.sizeBytes,
  };
}

module.exports = { uploadWhatsAppMediaForTicket, publicMetadata };
