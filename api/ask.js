askBtn.addEventListener('click', async () => {
  const q = askInput.value.trim();
  if (!q) return;

  askResult.innerHTML = '<div class="ask-loading">Thinking…</div>';

  try {
    // 1) Image Generation: "/gen ..." or "generate ..."
    if (isGen(q)) {
      const prompt = q.replace(/^\/?(gen|generate)\s*/i,'').trim() || prompt('Describe the image to generate:','photoreal rainy highway at night, reflections');
      if (!prompt) { askResult.textContent = 'Canceled.'; return; }
      const imgs = await doImgGenerate(prompt, { n: 2, aspect: '16:9', realism: 'photo' });
      askResult.innerHTML = `<p>Generated for: <strong>${prompt}</strong></p>`;
      askResult.appendChild(renderAskImages(imgs));
      return;
    }

    // 2) Image Browse: "/browse ..." or "search images ..."
    if (isBrowse(q)) {
      const query = q.replace(/^\/?(browse|find|search)\s*/i,'').replace(/\b(images?|photos?)\b/ig,'').trim() || prompt('Search images for:','rainy highway night');
      if (!query) { askResult.textContent = 'Canceled.'; return; }
      const imgs = await doImgBrowse(query, { n: 12 });
      askResult.innerHTML = `<p>Results for: <strong>${query}</strong></p>`;
      askResult.appendChild(renderAskImages(imgs));
      return;
    }

    // 3) Otherwise → normal KB answer
    const r = await fetch(`${API_BASE}/api/ai-expert`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ question: q })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'AI error');
    askResult.innerHTML = (j.answer || '').replace(/\n/g,'<br>');
  } catch (e){
    askResult.textContent = e.message || 'Something went wrong.';
  }
});