const { io } = require("socket.io-client");

const socket = io("http://localhost:3001");

socket.on("connect", () => {
    console.log("Connected");
    socket.emit("request-pairing-code", { phone: "573105615826" });
});

socket.on("pairing-code", (data) => {
    console.log("SUCCESS:", data);
    process.exit(0);
});

socket.on("pairing-code-error", (data) => {
    console.error("ERROR FROM SERVER:", data);
    process.exit(1);
});

setTimeout(() => {
    console.error("TIMEOUT");
    process.exit(1);
}, 5000);
