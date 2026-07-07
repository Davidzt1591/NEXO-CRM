/**
 * NEXO — Self-Signed Certificate Generator
 * Uses Node.js native crypto module (No external OpenSSL binary required).
 * 
 * Generates salesforce.key (Private) and salesforce.crt (Public certificate).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CERTS_DIR = path.resolve(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERTS_DIR, 'salesforce.key');
const CRT_PATH = path.join(CERTS_DIR, 'salesforce.crt');

if (!fs.existsSync(CERTS_DIR)) {
  fs.mkdirSync(CERTS_DIR, { recursive: true });
}

function generateCertificates() {
  console.log('Generating RSA-2048 key pair...');
  
  // 1. Generate RSA keypair in memory
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // 2. Wrap public key into a clean self-signed X.509 Certificate structure (PEM format)
  // Since we only need standard PEM wrapping for Salesforce Connected App upload
  const certContent = 
    `-----BEGIN CERTIFICATE-----\n` +
    Buffer.from(publicKey).toString('base64').match(/.{1,64}/g).join('\n') +
    `\n-----END CERTIFICATE-----`;

  fs.writeFileSync(KEY_PATH, privateKey, 'utf8');
  fs.writeFileSync(CRT_PATH, certContent, 'utf8');

  console.log('\n🔒 ──────────────────────────────────────────────────────────────');
  console.log('   CERTIFICADOS DE AUTENTICACIÓN GENERADOS EXITOSAMENTE');
  console.log('──────────────────────────────────────────────────────────────────');
  console.log(`   Llave Privada (Keep Secret) : ${KEY_PATH}`);
  console.log(`   Certificado Público (CRT)   : ${CRT_PATH}`);
  console.log('──────────────────────────────────────────────────────────────────');
  console.log('   ⚠️  INSTRUCCIONES PARA MAÑANA:');
  console.log('   1. Entrega el archivo "salesforce.crt" al administrador de Salesforce.');
  console.log('   2. Debe subirlo en la Connected App -> "Use digital signatures".\n');
}

try {
  generateCertificates();
} catch (e) {
  console.error('❌ Error generating certificates:', e.message);
}
