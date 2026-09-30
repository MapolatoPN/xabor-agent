// Sin DB, red, mensajes ni archivos de clientes. El proceso hijo acota también
// un bloqueo síncrono del detector (un Promise.race no puede cortarlo).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--hijo')) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=256',fileURLToPath(import.meta.url),'--hijo'],
    {encoding:'utf8',timeout:45000,maxBuffer:1024*1024,env:process.env});
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  assert.ifError(r.error);
  assert.equal(r.status,0,'La validación no debe bloquear ni terminar el servidor');
} else {
  const {tipoDeArchivoPermitido} = await import('../src/services/tiposDeArchivoSeguros.js');
  const {validarImagenReal,comprimirImagen} = await import('../src/services/imagenes.js');
  const {validarPdfReal} = await import('../src/services/documentos.js');
  const {fileTypeFromBuffer} = await import('file-type');
  const sharp = (await import('sharp')).default;
  const AdmZip = (await import('adm-zip')).default;
  const {extraerXmlsDeZip} = await import('../src/services/satClient.js');
  const {generarPdfCotizacion} = await import('../src/services/cotizacionPdf.js');
  const {extraerTextoPorPagina} = await import('../src/services/pdfTexto.js');
  // Reproducción mínima del encabezado ASF con subheader de tamaño cero.
  const asf = Buffer.alloc(55);
  Buffer.from('3026b2758e66cf11a6d900aa0062ce6c','hex').copy(asf);
  const invalidos=[asf,Buffer.from('<svg onload="alert(1)"/>'),Buffer.from('MZ-falso.jpg'),
    Buffer.from('504b0304','hex'),Buffer.from('89504e470d0a1a0a','hex')];
  for (const b of invalidos) {
    assert.equal((await validarImagenReal(b)).valido,false);
    assert.equal((await validarPdfReal(b)).valido,false);
  }
  // Se prueba la dependencia nueva además del prefiltro del servicio.
  await fileTypeFromBuffer(asf).catch(e=>assert(e instanceof Error));
  console.log('OK archivos: ASF malformado, firmas truncadas y formatos fuera de contrato.');
  for (const formato of ['jpeg','png','webp']) {
    const imagen=await sharp({create:{width:120,height:80,channels:3,background:'#eee'}})[formato]().toBuffer();
    const r=await validarImagenReal(imagen);assert.equal(r.valido,true,formato);
    const comprimida=await comprimirImagen(imagen,r.mime);
    assert.equal((await validarImagenReal(comprimida.buffer)).valido,true);
    assert.equal((await validarPdfReal(imagen)).valido,false);
  }
  assert.equal(await tipoDeArchivoPermitido(Buffer.from('%PDF-1.4'), 'desconocido'),null);
  console.log('OK archivos: imágenes JPEG, PNG y WebP reales, compresión y tipo independiente del nombre.');
  const zip=new AdmZip();zip.addFile('prueba.xml',Buffer.from('<Comprobante Total="25"/>'));
  zip.addFile('ignorar.txt',Buffer.from('no es xml'));
  assert.deepEqual(await extraerXmlsDeZip(zip.toBuffer()),[{nombre:'prueba.xml',xml:'<Comprobante Total="25"/>'}]);
  console.log('OK archivos: lectura ZIP compatible con el consumidor SAT, sin red.');
  const pdf=await generarPdfCotizacion({folio:'PRUEBA-LOCAL',version:1,created_at:'2026-09-30',
    items:[{descripcion:'Taco de prueba',cantidad:2,precio_unitario:25}],subtotal:50,total:50,impuestos:0},
    {nombre:'Restaurante de prueba'},{esBorrador:true});
  assert(Buffer.isBuffer(pdf));assert.equal((await validarPdfReal(pdf)).valido,true);
  const texto=await extraerTextoPorPagina(pdf);
  assert.match(texto.paginas.map(p=>p.texto).join('\n'),/Taco de prueba/);
  await assert.rejects(extraerTextoPorPagina(Buffer.from('%PDF-invalido')),e=>e.codigo==='PDF_ILEGIBLE');
  console.log('OK archivos: Chromium genera PDF y pdfjs extrae texto; PDF ilegible rechazado.');
}
