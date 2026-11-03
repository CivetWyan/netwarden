document.getElementById('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=document.getElementById('login');button.disabled=true;
  try {const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value}),signal:AbortSignal.timeout(10000)});const data=await r.json();if(!r.ok)throw Error(data.error);location.reload();}
  catch(e){document.getElementById('login-error').textContent=e.message;}
  finally{button.disabled=false;}
});
