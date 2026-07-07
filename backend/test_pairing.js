const { io } = require('socket.io-client');
const fs = require('fs');

const socket = io('http://localhost:3001', { transports: ['websocket'] });

socket.on('connect', () => {
    console.log('Solicitando código...');
    socket.emit('request-pairing-code', { phone: '573102239549' });
});

socket.on('pairing-code', (data) => {
    console.log('Exito:', data);
    process.exit(0);
});

socket.on('pairing-code-error', (data) => {
    console.log('Fallo de emparejamiento emitido');
    setTimeout(() => {
        if (fs.existsSync('pairing_err.txt')) {
            console.log(fs.readFileSync('pairing_err.txt', 'utf8'));
        }
        process.exit(0);
    }, 1000);
});
