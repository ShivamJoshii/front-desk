# Inline css/js/icons into web/dist/index.html
import pathlib
w=pathlib.Path("web"); h=(w/"app.html").read_text()
h=h.replace("/*BLUEPRINT_CSS*/",(w/"blueprint.css").read_text(),1)
h=h.replace("/*BASE_CSS*/",(w/"base.css").read_text(),1)
h=h.replace("/*FOCUS_CSS*/",(w/"focus.css").read_text(),1)
h=h.replace("<!--ICONS-->",(w/"icons.svg").read_text(),1)
h=h.replace("/*APP_JS*/",(w/"app.js").read_text().replace("</script>","<\\/script>"),1)
(w/"dist").mkdir(exist_ok=True); (w/"dist"/"index.html").write_text(h)
print("dist/index.html", len(h))
