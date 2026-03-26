(function(){
  var app = document.getElementById('app');
  var menuBtn = document.getElementById('menuBtn');
  var menuPanel = document.getElementById('menuPanel');
  var menuList = document.getElementById('menuList');
  var el = window.Psynovia.el;
  var PAGES = window.PAGES;

  function closeMenu(){
    menuPanel.classList.remove('open');
    menuPanel.setAttribute('aria-hidden', 'true');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu(){
    var open = menuPanel.classList.toggle('open');
    menuPanel.setAttribute('aria-hidden', String(!open));
    menuBtn.setAttribute('aria-expanded', String(open));
  }
  menuBtn.addEventListener('click', function(e){
    e.preventDefault();
    toggleMenu();
  });
  document.addEventListener('click', function(e){
    var inside = menuPanel.contains(e.target) || menuBtn.contains(e.target);
    if (!inside) closeMenu();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closeMenu();
  });

  (PAGES.site.menu || []).forEach(function(item){
    var a = el('a', { class: 'menuItem', href: item.href }, item.label);
    a.addEventListener('click', function(){ setTimeout(closeMenu, 0); });
    menuList.appendChild(a);
  });

  var renderers = {
    HeroCard: window.Psynovia.renderHeroCard,
    TextBlock: window.Psynovia.renderTextBlock,
    PriceBoxes: window.Psynovia.renderPriceBoxes,
    FinalCTA: window.Psynovia.renderFinalCTA,
    StartPlaceholder: window.Psynovia.renderStartPlaceholder
  };

  (PAGES.home.blocks || []).forEach(function(block){
    var render = renderers[block.type];
    if(render) app.appendChild(render(block));
  });
})();
