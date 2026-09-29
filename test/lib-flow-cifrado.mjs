import { randomBytes,createCipheriv,createDecipheriv,publicEncrypt,constants,createHmac } from 'node:crypto';
export function peticionCifrada(solicitud,publicKey,secreto) {
  const aes=randomBytes(16),iv=randomBytes(16),cipher=createCipheriv('aes-128-gcm',aes,iv);
  const body=JSON.stringify({encrypted_aes_key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash:'sha256'},aes).toString('base64'),initial_vector:iv.toString('base64'),
    encrypted_flow_data:Buffer.concat([cipher.update(JSON.stringify(solicitud)),cipher.final(),cipher.getAuthTag()]).toString('base64')});
  return {body,headers:{'Content-Type':'application/json','X-Hub-Signature-256':`sha256=${createHmac('sha256',secreto).update(body).digest('hex')}`},
    descifrar:raw=>{
      const datos=Buffer.from(raw,'base64'),decipher=createDecipheriv('aes-128-gcm',aes,Buffer.from(iv.map(b=>b^255)));
      decipher.setAuthTag(datos.subarray(-16));
      return JSON.parse(Buffer.concat([decipher.update(datos.subarray(0,-16)),decipher.final()]).toString('utf8'));
    }};
}
