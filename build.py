# Inline css/js/icons into web/dist/index.html (+ _redirects for the SPA routes, + PWA manifest)
import json, pathlib
w=pathlib.Path("web"); h=(w/"app.html").read_text()
h=h.replace("/*BLUEPRINT_CSS*/",(w/"blueprint.css").read_text(),1)
h=h.replace("/*BASE_CSS*/",(w/"base.css").read_text(),1)
h=h.replace("/*FOCUS_CSS*/",(w/"focus.css").read_text(),1)
h=h.replace("<!--ICONS-->",(w/"icons.svg").read_text(),1)
h=h.replace("/*APP_JS*/",(w/"app.js").read_text().replace("</script>","<\\/script>"),1)
d=w/"dist"; d.mkdir(exist_ok=True); (d/"index.html").write_text(h)
# /connect/quickbooks and /settings/quickbooks are handled by the app, so every path serves index.html
(d/"_redirects").write_text("/*  /index.html  200\n")
(d/"manifest.webmanifest").write_text(json.dumps({"name":"Front Desk","short_name":"Front Desk","start_url":"/","display":"standalone","background_color":"#f6f7f9","theme_color":"#2d72d2"}, indent=2))
print("dist/index.html", len(h))
