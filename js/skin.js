// Gewähltes Design schon vor dem ersten Zeichnen setzen (kein Aufblitzen im falschen Design)
try{var s=JSON.parse(localStorage.getItem("skin")||"null");if(s==="holo")document.documentElement.dataset.skin=s;else localStorage.removeItem("skin");}catch(e){}
