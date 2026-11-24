// Solo lectura: consulta /users/me. No crea contratos ni pagos.
import 'dotenv/config';
import {verificarCuentaMpSaas,mpSaasHabilitado} from '../src/services/mercadoPagoSaasCliente.js';
try {
  const cuenta=await verificarCuentaMpSaas();
  console.log(JSON.stringify({...cuenta,soloLectura:true,contratacionHabilitada:mpSaasHabilitado()}));
} catch {
  console.error(JSON.stringify({vendedorVerificado:false,soloLectura:true,
    motivo:'Revisar modo, vendedor esperado y credencial SaaS en las variables seguras del entorno.'}));
  process.exitCode=1;
}
