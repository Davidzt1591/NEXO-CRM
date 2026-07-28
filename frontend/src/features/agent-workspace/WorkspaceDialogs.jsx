import SalesforceCaseModal from '../../components/SalesforceCaseModal';
import ConnectionDialog from '../connection/ConnectionDialog';

export default function WorkspaceDialogs({ socket, workspace }) {
  const closeSalesforce = () => workspace.setSfModal({ open: false, ticket: null });
  const caseCreated = data => {
    if (!data?.sf_case_id || !workspace.sfModal.ticket?.contactKey) return;
    const key = workspace.sfModal.ticket.contactKey;
    workspace.setContacts(previous => ({ ...previous, [key]: { ...previous[key], sf_case_id: data.sf_case_id, sf_case_number: data.sf_case_number } }));
  };
  return <><ConnectionDialog open={workspace.showQR} onClose={() => workspace.setShowQR(false)} qrDataUrl={workspace.qrDataUrl} qrCountdown={workspace.qrCountdown} pairingCode={workspace.pairingCode} pairingError={workspace.pairingError} pairingLoading={workspace.pairingLoading} onRequestQr={() => socket.emit('request-qr')} onRequestPairing={phone => { workspace.setPairingCode(null); workspace.setPairingError(null); workspace.setPairingLoading(true); socket.emit('request-pairing-code', { phone }); }} onResetPairing={() => { workspace.setPairingCode(null); workspace.setPairingError(null); workspace.setPairingLoading(false); }} />{workspace.sfModal.open ? <SalesforceCaseModal ticket={workspace.sfModal.ticket} onClose={closeSalesforce} onCaseCreated={caseCreated} /> : null}</>;
}
