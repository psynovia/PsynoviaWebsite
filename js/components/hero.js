window.Psynovia = window.Psynovia || {};
window.Psynovia.renderHeroCard = function(block){
  var el = window.Psynovia.el;
  return el('section', { class: 'section heroCard', id: block.id },
    el('h1', {}, block.headline),
    el('p', {}, block.text)
  );
};
