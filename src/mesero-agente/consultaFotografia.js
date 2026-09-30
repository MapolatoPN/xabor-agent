// Una foto sin objeto no es una solicitud del menú. No interpretar imágenes
// ni pedidos mixtos con esta regla; solo pedir la aclaración faltante.
export function consultaFotografiaAmbigua(mensaje) {
  const t=String(mensaje || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[¡!¿?,.;:\s]+/g,' ').trim();
  return /^(?:(?:hola|buenos dias|buenas tardes|buen dia) )?(?:un favor )?(?:(?:tu )?crees que )?(?:(?:me )?(?:puedes|puedas|podrias|podras|puedan|pueden) (?:mandar|enviar|apoyar con|ayudar con)|(?:me )?(?:mandas|envias)|quiero|necesito) (?:una |la )?(?:foto|fotografia|imagen)(?: (?:por favor|porfa|xfis|porfis|gracias))?$/.test(t);
}
