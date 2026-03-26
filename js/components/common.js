window.Psynovia = window.Psynovia || {};
window.Psynovia.el = function(tag, attrs){
  var node = document.createElement(tag);
  attrs = attrs || {};
  for(var k in attrs){
    if(attrs[k] == null) continue;
    if(k === 'class') node.className = attrs[k];
    else if(k === 'html') node.innerHTML = attrs[k];
    else node.setAttribute(k, attrs[k]);
  }
  for(var i=2; i<arguments.length; i++){
    var child = arguments[i];
    if(child == null) continue;
    if(Array.isArray(child)){
      child.forEach(function(c){
        if(c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    } else {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
};
