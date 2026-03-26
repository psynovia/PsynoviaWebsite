window.Psynovia = window.Psynovia || {};
window.Psynovia.renderFinalCTA = function(block){
  var el = window.Psynovia.el;
  return el('section', { class: 'section finalCtaWrap', id: block.id },
    el('a', { class: 'finalCtaButton', href: block.href }, block.headline),
    el('p', { class: 'finalCtaSub' }, block.sub)
  );
};

window.Psynovia.renderStartPlaceholder = function(block){
  var el = window.Psynovia.el;
  return el('section', { class: 'section startPlaceholder', id: block.id },
    el('div', { class: 'startPlaceholderBox' },
      el('h2', {}, block.headline),
      el('p', { style: 'white-space:pre-line; color: var(--mut); margin:0;' }, block.text)
    )
  );
};
