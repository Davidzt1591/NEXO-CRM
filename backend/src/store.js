const store = {
  sesiones: {},
  chatModes: new Map(),
  silenciados: new Set(),
  lastQR: null,
  lastQRTime: 0,
  QR_THROTTLE: 20000,
  botActivo: false,
  pendingPairingPhone: null,
  horaDeInicio: Math.floor(Date.now() / 1000)
};

console.log('🔄 Init Store...');
module.exports = store;
