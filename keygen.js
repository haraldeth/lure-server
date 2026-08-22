/* Genera un keypair Ed25519 nuevo para el attester de THE ABYSS.
   Uso:
     cd gameserver
     npm install
     npm run keygen
   Te da DOS valores:
     ATTESTER_SECRET_KEY  -> pegalo TAL CUAL en el env var de Render (server.js
                              lo lee con ATTESTER_SECRET_KEY). NUNCA lo pongas
                              en index.html ni en ningun sitio que el navegador
                              pueda leer.
     ATTESTER_PUBLIC_KEY  -> esta es la que va en `config.attester` on-chain
                              (instruccion set_attester / update_config de tu
                              programa). El servidor firma con la privada;
                              la cadena valida contra esta publica.
*/
const nacl = require('tweetnacl');
const { PublicKey } = require('@solana/web3.js');

const kp = nacl.sign.keyPair();
const secretKey = Array.from(kp.secretKey); // 64 bytes: 32 seed + 32 pubkey

console.log('ATTESTER_SECRET_KEY (env var de Render, pegar tal cual):');
console.log(JSON.stringify(secretKey));
console.log('');
console.log('ATTESTER_PUBLIC_KEY (esto va en config.attester on-chain):');
console.log(new PublicKey(kp.publicKey).toBase58());
