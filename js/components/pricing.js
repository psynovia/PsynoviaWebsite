window.Psynovia = window.Psynovia || {};
window.Psynovia.renderPriceBoxes = function(block){
  var el = window.Psynovia.el;
  var boxes = (block.boxes || []).map(function(box){
    return el('div', { class: 'priceBox' },
      el('div', { class: 'priceBoxTitle' }, box.title),
      el('div', { class: 'priceBoxPrice' }, box.price),
      el('p', {}, box.text)
    );
  });
  return el('section', { class: 'section priceBoxesWrap', id: block.id },
    el('h2', {}, block.headline),
    el('div', { class: 'priceBoxesGrid' }, boxes)
  );
};
