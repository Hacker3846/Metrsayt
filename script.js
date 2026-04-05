 function c() {
        const g = id => document.getElementById(id), v = id => g(id).value;
        const p = +v('p')||0, l = +v('l')||0, w = +v('w')||0, hStr = v('h').trim();
        const isV = hStr !== "" && !isNaN(+hStr), res = isV ? l * w * (+hStr) : l * w;
        g('title').innerText = isV ? "Расчет объема" : "Расчет площади";
        g('lbl').innerText = isV ? "Итоговый объем:" : "Итоговая площадь:";
        g('rf').innerText = +res.toFixed(4);
        g('rm').innerText = (res * p).toLocaleString('ru-RU') + " руб.";
    }
