export function prepararCamaraTicket({alCapturar,alSubir}) {
  const dialog=document.createElement('dialog');
  dialog.id='camera-dialog';
  dialog.setAttribute('aria-labelledby','camera-title');
  dialog.innerHTML=`<div class="dialog-head"><h2 id="camera-title">Tomar foto del ticket</h2><button type="button" class="secondary" id="camera-close">Cerrar</button></div><p>Coloca el ticket completo dentro de la imagen, con buena luz y sin reflejos.</p><p id="camera-status" role="status">Abriendo cámara…</p><video id="camera-video" autoplay muted playsinline style="width:100%;max-height:55dvh;background:#18251e;border-radius:8px"></video><img id="camera-preview" alt="Foto del ticket antes de enviarla" hidden style="width:100%;max-height:55dvh;object-fit:contain"><div class="dialog-actions"><button type="button" class="secondary" id="camera-upload">Subir imagen</button><button type="button" class="secondary" id="camera-retake" hidden>Repetir foto</button><button type="button" id="camera-snap" disabled>Tomar foto</button><button type="button" id="camera-use" hidden>Usar foto</button></div>`;
  document.body.append(dialog);
  const el=id=>dialog.querySelector('#camera-'+id);
  let stream=null,blob=null,preview=null,intento=0;
  function detener(){stream?.getTracks().forEach(t=>t.stop());stream=null;el('video').srcObject=null;}
  function limpiar(){intento++;detener();blob=null;if(preview)URL.revokeObjectURL(preview);preview=null;el('preview').removeAttribute('src');}
  function cerrar(){limpiar();dialog.close();}
  async function abrir(){
    limpiar();const actual=intento;
    if(!dialog.open)dialog.showModal();
    el('video').hidden=false;el('preview').hidden=true;el('snap').hidden=false;el('snap').disabled=true;el('use').hidden=true;el('retake').hidden=true;
    el('status').textContent='Abriendo cámara…';
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('NO_CAMERA');
      const nueva=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
      if(actual!==intento||!dialog.open){nueva.getTracks().forEach(t=>t.stop());return;}
      stream=nueva;el('video').srcObject=nueva;await el('video').play();
      if(actual!==intento||!dialog.open)return;
      el('snap').disabled=false;el('status').textContent='Revisa que las letras se vean claras antes de tomar la foto.';
    }catch(e){
      if(actual!==intento||!dialog.open)return;
      detener();el('video').hidden=true;
      el('status').textContent=e.name==='NotAllowedError'?'No se permitió usar la cámara. Puedes habilitarla en los permisos del navegador o subir una imagen.':'No pudimos abrir una cámara. Comprueba que esté conectada y disponible, o sube una imagen.';
    }
  }
  document.getElementById('new-camera').onclick=abrir;
  el('close').onclick=cerrar;dialog.addEventListener('cancel',limpiar);dialog.addEventListener('close',limpiar);
  window.addEventListener('pagehide',cerrar);
  el('upload').onclick=()=>{cerrar();alSubir();};el('retake').onclick=abrir;
  el('snap').onclick=async()=>{
    const video=el('video');if(!video.videoWidth||!video.videoHeight)return;
    const actual=intento;el('snap').disabled=true;
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
    const foto=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.92));
    if(actual!==intento||!dialog.open)return;
    if(!foto){el('snap').disabled=false;el('status').textContent='No se pudo tomar la foto. Intenta de nuevo.';return;}
    blob=foto;detener();preview=URL.createObjectURL(foto);el('preview').src=preview;el('preview').hidden=false;video.hidden=true;el('snap').hidden=true;el('use').hidden=false;el('retake').hidden=false;
    el('status').textContent='Revisa la foto. Solo se enviará para analizar al pulsar “Usar foto”.';
  };
  el('use').onclick=()=>{if(!blob)return;const file=new File([blob],'ticket-camara.jpg',{type:'image/jpeg'});cerrar();alCapturar(file);};
}
