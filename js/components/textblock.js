window.Psynovia = window.Psynovia || {};
window.Psynovia.renderTextBlock = function(block){
  var el = window.Psynovia.el;
  return el('section', { class: 'section textBlock', id: block.id },
    el('h2', {}, block.headline),
    el('p', {}, block.text)
  );
};
