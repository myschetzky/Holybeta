/* Tema: lyst er standard; mørkt vælges under Indstillinger og huskes i browseren. Indlæses i <head>, før siden tegnes. */
(function () {
  try { if (localStorage.getItem('hm-theme') === 'dark') document.documentElement.setAttribute('data-hm-theme', 'dark'); } catch (e) { /* privat vindue */ }
})();
