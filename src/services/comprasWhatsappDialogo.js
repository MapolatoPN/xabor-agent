// Comandos deliberadamente explícitos: una conversación casual nunca mueve dinero.
export function telefonoComprador(valor) {
  const n = String(valor || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(n)) return `52${n}`;
  if (/^521\d{10}$/.test(n)) return `52${n.slice(3)}`;
  return /^52\d{10}$/.test(n) ? n : null;
}

export function comandoCompra(texto) {
  const t = String(texto || '').trim();
  if (/^compras$/i.test(t)) return { tipo: 'ayuda' };
  const m = t.match(/^(confirmar|cancelar)\s+([a-f0-9]{8})-v([1-9][0-9]*)(?:\s+(fondo|credito|crédito|cuenta)(?:\s+(.+))?)?$/i);
  if (!m) return null;
  const tipo = m[1].toLowerCase(), codigo = m[2].toLowerCase(), version = Number(m[3]);
  if (tipo === 'cancelar') return !m[4] ? { tipo, codigo, version } : null;
  const origen = m[4]?.toLowerCase().replace('é', 'e');
  if (!origen || (origen === 'cuenta' && !m[5]?.trim()) || (origen !== 'cuenta' && m[5])) return null;
  return { tipo, codigo, version, origen, cuenta: m[5]?.trim().slice(0, 180) };
}

export function resumenTicketWhatsapp(compra) {
  const codigo = compra.id.slice(0, 8)+'-v'+compra.version;
  const renglones = (compra.items || []).slice(0, 12).map(i => `• ${String(i.descripcion).slice(0,100)}: $${Number(i.importe || 0).toFixed(2)}`).join('\n');
  const fecha=compra.fecha instanceof Date ? compra.fecha.toISOString().slice(0,10) : String(compra.fecha || 'Por revisar').slice(0,10);
  const total=compra.total==null ? 'Por revisar' : '$'+Number(compra.total).toFixed(2)+' MXN';
  return `Borrador de compra ${codigo}\n${compra.proveedor || 'Proveedor por revisar'}\nFecha: ${fecha}\nTotal: ${total}\n${renglones}\nRevisa los datos${compra.advertencias?.length ? ' y las advertencias de lectura en el panel' : ''}.\nPara registrar responde:\nCONFIRMAR ${codigo} FONDO\nCONFIRMAR ${codigo} CREDITO\nCONFIRMAR ${codigo} CUENTA nombre de la cuenta\nO CANCELAR ${codigo}.\nPuedes corregir conceptos y total en https://xabor.mx/compras.html antes de confirmar.`;
}
