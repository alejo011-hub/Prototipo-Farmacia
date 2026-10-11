'use strict';

/**
 * Asistente de Droguería Ermita.
 * - Funciona 100 % en el navegador, con reglas locales (sin servidor ni IA externa).
 * - Precios y existencias: lee `state.products` y `state.cart` de app.js. Solo modifica
 *   el carrito cuando la persona pulsa "Agregar al carrito" (usa addToCart de app.js).
 * - Orientación de uso y dosis: lee guia-productos.json, un archivo aparte, para no
 *   cambiar el modelo compartido de producto de 9 campos.
 */
(function () {
  const AVISO = 'Información de referencia para adultos. No reemplaza la etiqueta del producto ni la consulta con un médico o químico farmacéutico.';
  const NUMEROS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
  const PALABRAS_VACIAS = new Set(['para', 'con', 'los', 'las', 'del', 'una', 'uno', 'por']);
  const MAX_MENSAJES = 40;

  const chat = { guias: null, promesaGuias: null, productoId: '', esperaDias: false };

  const el = {
    toggle: document.getElementById('chatToggle'),
    panel: document.getElementById('chatPanel'),
    close: document.getElementById('chatClose'),
    log: document.getElementById('chatLog'),
    form: document.getElementById('chatForm'),
    input: document.getElementById('chatInput'),
    select: document.getElementById('chatProduct'),
    chips: document.getElementById('chatChips'),
  };
  if (!el.toggle || !el.panel) return;

  const RE = {
    emergencia: /sobredosis|intoxic|envenen|tome de mas|tome demasiad|tome muchas|me pase de la dosis|se tomo|se bebio|se trago|no puedo respirar|dolor (fuerte )?en el pecho|desmay|convuls/,
    restringido: /\b(nino|nina|ninos|ninas|bebe|bebes|hijo|hija|hijos|hijas|pediatric\w*|lactante|recien nacido|\d+\s*meses)\b|menor(es)? de (edad|\d)|embaraz|lactancia|amamant|gestant|alergi|ulcera|gastritis|rinon|renal|higado|hepatic|hipertens|diabet|anticoagul|warfarina|asma|corazon|cardiac|otros? medicamentos?/,
    dosis: /dosis|dosificacion|posologia|cada cuant|cuantas? (veces|tabletas?|capsulas?|pastillas?)|cuanto (debo |puedo |se debe )?(tomar|usar)|como (se )?(toma|tomo|tomar|usa|usar|uso|aplica|aplicar)|frecuencia|horario|modo de uso|instrucciones/,
    recomendacion: /recomiend|recomend|sugier|suger|aconsej|complement|acompan|combina|alternativa|que mas (llevo|compro)/,
    barato: /mas barato|mas economic|menor precio|mas caro|mas costoso|mayor precio/,
    presupuesto: /presupuesto|tengo \$?\s?\d|con \$?\s?\d|alcanza|menos de|hasta \$?\s?\d|maximo \$?\s?\d|me quedan/,
    saludo: /^\s*(hola|buenas|buenos|buen dia|hey|ayuda|menu|opciones|que puedes|que haces)/,
    total: /total|cuanto (es|cuesta|cuestan|sale|saldria|seria|llevo|debo pagar|pago|vale|valen)|precio|costo|suma|sumar|calcul|pagar/,
  };

  // ---------- Utilidades ----------
  const norm = (texto) => String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lista = (valor) => (Array.isArray(valor) ? valor.filter((x) => typeof x === 'string') : []);
  const guiaDe = (id) => (chat.guias ? chat.guias.productos[id] : undefined);
  const dinero = (valor, producto) => formatPrice(valor, producto.moneda);

  function disponibilidad(p) {
    const estado = getAvailabilityStatus(p.existencias, p.stockMinimo);
    if (estado === 'out') return 'agotado';
    if (estado === 'low') return `stock bajo (${p.existencias} disponibles)`;
    return `disponible (${p.existencias} unidades)`;
  }

  function aNumero(palabra) {
    return /^\d+$/.test(palabra) ? parseInt(palabra, 10) : NUMEROS[palabra];
  }

  // ---------- Guía de uso (datos aparte) ----------
  function ensureGuides() {
    if (chat.promesaGuias) return chat.promesaGuias;
    chat.promesaGuias = (async () => {
      try {
        const res = await fetch('guia-productos.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || typeof data.productos !== 'object' || data.productos === null) {
          throw new Error('formato inválido');
        }
        const productos = {};
        Object.entries(data.productos).forEach(([id, guia]) => {
          if (!guia || typeof guia.uso !== 'string') {
            console.warn(`Guía ignorada (${id}): falta el campo "uso".`);
            return;
          }
          const d = guia.dosis;
          const dosisValida = d && typeof d.adultos === 'string' && typeof d.intervaloHoras === 'string'
            && typeof d.maximoDiario === 'string' && d.calculo
            && Number.isFinite(d.calculo.unidadesPorToma) && Number.isFinite(d.calculo.tomasPorDia);
          productos[id] = { ...guia, dosis: dosisValida ? d : null };
        });
        chat.guias = { productos };
      } catch (error) {
        console.warn('La guía de uso no está disponible:', error);
        chat.guias = { productos: {} };
      }
    })();
    return chat.promesaGuias;
  }

  // ---------- Reconocimiento de productos y cantidades ----------
  function tokensDe(producto) {
    return norm(producto.nombre).split(/[^a-z0-9]+/)
      .filter((tok) => tok.length >= 3 && !/\d/.test(tok) && !PALABRAS_VACIAS.has(tok));
  }

  function cantidadAntes(t, pos) {
    const antes = t.slice(0, pos).trim();
    const m = antes.match(/(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(?:unidades?|und|cajas?|frascos?|tubos?|vendas?)?\s*(?:de)?\s*$/);
    const n = m ? aNumero(m[1]) : 1;
    return n > 0 ? n : 1;
  }

  function productosMencionados(texto) {
    const t = norm(texto);
    const encontrados = [];
    state.products.forEach((p) => {
      let pos = -1;
      tokensDe(p).forEach((tok) => {
        const m = new RegExp(tok.length <= 4 ? `\\b${tok}\\b` : `\\b${tok}`).exec(t);
        if (m && (pos < 0 || m.index < pos)) pos = m.index;
      });
      if (pos >= 0) encontrados.push({ product: p, pos, qty: cantidadAntes(t, pos) });
    });
    return encontrados.sort((a, b) => a.pos - b.pos);
  }

  function categoriaEn(t) {
    const categorias = [...new Set(state.products.map((p) => p.categoria))];
    return categorias.find((c) => {
      const raiz = norm(c).replace(/(es|s)$/, '');
      return raiz.length >= 4 && t.includes(raiz);
    });
  }

  function objetivos(encontrados) {
    if (encontrados.length) return encontrados.map((e) => e.product);
    const elegido = findProductById(chat.productoId);
    if (elegido) return [elegido];
    return state.cart.map((i) => findProductById(i.id)).filter(Boolean);
  }

  function leerDias(t) {
    const m = t.match(/(\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(dias?|semanas?)/);
    if (!m) return null;
    const n = aNumero(m[1]);
    return /^semana/.test(m[2]) ? n * 7 : n;
  }

  function leerPresupuesto(t) {
    const limpio = t.replace(/\$/g, ' ');
    const re = /(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(mil|k)?\b/g;
    let mejor = 0;
    let m = re.exec(limpio);
    while (m) {
      let n = parseInt(m[1].replace(/[.,]/g, ''), 10);
      if (m[2]) n *= 1000;
      if (n > mejor) mejor = n;
      m = re.exec(limpio);
    }
    return mejor >= 100 ? mejor : 0;
  }

  function empaque(p) {
    for (const c of p.caracteristicas) {
      const m = c.match(/x\s*(\d+)\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/);
      if (m) return { cantidad: parseInt(m[1], 10), unidad: m[2].toLowerCase() };
    }
    return null;
  }

  // ---------- Cálculo de precios ----------
  function cotizar(items) {
    const lineas = [];
    const avisos = [];
    const totales = {};
    items.forEach(({ product: p, qty }) => {
      if (p.existencias === 0) {
        avisos.push(`${p.nombre} está agotado y no se incluye en el cálculo.`);
        return;
      }
      let q = qty;
      if (q > p.existencias) {
        avisos.push(`De ${p.nombre} solo hay ${p.existencias} disponibles (pediste ${q}); calculé con ${p.existencias}.`);
        q = p.existencias;
      }
      const subtotal = p.precio * q;
      totales[p.moneda] = (totales[p.moneda] || 0) + subtotal;
      lineas.push(`${q} × ${p.nombre}: ${formatPrice(subtotal, p.moneda)}`);
    });
    const total = Object.entries(totales).map(([m, v]) => formatPrice(v, m)).join(' + ');
    return { lineas, avisos, total, vacio: lineas.length === 0 };
  }

  function respuestaCotizacion(items, conAccion) {
    const c = cotizar(items);
    if (c.vacio) return [...c.avisos, 'No hay productos disponibles para calcular.'];
    const bloques = [{ t: 'ul', items: c.lineas }, { t: 'strong', text: `Total: ${c.total}` }];
    c.avisos.forEach((a) => bloques.push({ t: 'small', text: a }));
    if (conAccion) {
      bloques.push({
        t: 'actions',
        items: [{ label: '🛒 Agregar al carrito', fn: () => items.forEach(({ product, qty }) => agregar(product.id, qty)) }],
      });
    }
    return bloques;
  }

  function totalCarrito() {
    if (!state.cart.length) {
      return ['Tu carrito está vacío. Dime qué productos y cuántos, y te calculo el total. Por ejemplo: "2 paracetamol y 1 vitamina C".'];
    }
    const items = state.cart.map((i) => ({ product: findProductById(i.id), qty: i.cantidad })).filter((i) => i.product);
    return ['Esto es lo que llevas en el carrito:', ...respuestaCotizacion(items, false)];
  }

  function extremos(t) {
    const cat = categoriaEn(t);
    const base = state.products.filter((p) => p.existencias > 0 && (!cat || p.categoria === cat));
    if (!base.length) return ['No encuentro productos disponibles con ese criterio.'];
    const ordenados = [...base].sort((a, b) => a.precio - b.precio);
    const barato = ordenados[0];
    const caro = ordenados[ordenados.length - 1];
    const donde = cat ? ` en ${cat}` : '';
    return [{ t: 'ul', items: [
      `Más barato disponible${donde}: ${barato.nombre} (${dinero(barato.precio, barato)})`,
      `Más caro disponible${donde}: ${caro.nombre} (${dinero(caro.precio, caro)})`,
    ] }];
  }

  function presupuesto(t, encontrados) {
    const monto = leerPresupuesto(t);
    const moneda = state.products[0].moneda;
    const dineroTotal = formatPrice(monto, moneda);
    if (encontrados.length) {
      return [{ t: 'ul', items: encontrados.map(({ product: p }) => {
        if (p.existencias === 0) return `${p.nombre}: agotado.`;
        const q = p.precio === 0 ? p.existencias : Math.min(Math.floor(monto / p.precio), p.existencias);
        if (q === 0) return `${p.nombre}: no alcanza con ${dineroTotal} (cuesta ${dinero(p.precio, p)}).`;
        return `Con ${dineroTotal} puedes llevar hasta ${q} × ${p.nombre} (${dinero(q * p.precio, p)}).`;
      }) }];
    }
    const alcanzan = state.products.filter((p) => p.existencias > 0 && p.precio <= monto).sort((a, b) => a.precio - b.precio);
    if (!alcanzan.length) return [`Con ${dineroTotal} no alcanza para ningún producto disponible.`];
    return [`Con ${dineroTotal} puedes comprar:`, { t: 'ul', items: alcanzan.slice(0, 8).map((p) => `${p.nombre}: ${dinero(p.precio, p)}`) }];
  }

  // ---------- Orientación de uso, dosis y recomendaciones ----------
  function pedirProducto() {
    return ['Dime de qué producto hablas (escribe su nombre) o elígelo en "Producto en consulta".'];
  }

  function accionesProducto(p) {
    fijarProducto(p.id);
    return { t: 'actions', items: [
      { label: '🧮 Calcular cuánto necesito', fn: () => enviar('Quiero calcular el tratamiento') },
      { label: '👍 Recomendaciones', fn: () => enviar('¿Qué me recomiendas con este producto?') },
    ] };
  }

  function dosis(targets) {
    if (!targets.length) return pedirProducto();
    const bloques = [];
    targets.slice(0, 3).forEach((p) => {
      const g = guiaDe(p.id);
      bloques.push({ t: 'h', text: p.nombre });
      if (!g) {
        bloques.push('No tengo una guía de uso para este producto. Sigue la etiqueta o consulta al químico farmacéutico.');
        return;
      }
      bloques.push(g.uso);
      if (g.dosis) {
        const d = g.dosis;
        const items = [
          `Adultos: ${d.adultos}`,
          d.intervaloHoras === '24' ? 'Frecuencia: una vez al día.' : `Frecuencia: cada ${d.intervaloHoras} horas.`,
          `Límite: ${d.maximoDiario}`,
        ];
        if (d.duracionMaximaDias) items.push(`Sin consultar a un médico, no lo uses más de ${d.duracionMaximaDias} días seguidos.`);
        bloques.push({ t: 'ul', items });
      } else if (typeof g.instruccionesDeUso === 'string') {
        bloques.push(g.instruccionesDeUso);
      }
      if (lista(g.precauciones).length) bloques.push({ t: 'strong', text: 'Ten en cuenta:' }, { t: 'ul', items: lista(g.precauciones) });
      if (lista(g.consultarSi).length) bloques.push({ t: 'strong', text: 'Consulta a un profesional si:' }, { t: 'ul', items: lista(g.consultarSi) });
    });
    bloques.push({ t: 'warn', text: 'Esta es la dosis habitual de referencia, no una dosis personalizada ni una garantía de mejoría. Si los síntomas no mejoran en los plazos indicados, consulta a un profesional.' });
    bloques.push({ t: 'small', text: AVISO });
    if (targets.length === 1 && guiaDe(targets[0].id)?.dosis) bloques.push(accionesProducto(targets[0]));
    return bloques;
  }

  function tratamiento(targets, dias) {
    if (!targets.length) return pedirProducto();
    const conCalculo = targets.filter((p) => guiaDe(p.id)?.dosis);
    if (!conCalculo.length) return ['Para este producto no puedo estimar un tratamiento: sigue la etiqueta o consulta al químico farmacéutico.'];
    if (dias === null) {
      chat.esperaDias = true;
      return ['¿Para cuántos días? Escríbelo, por ejemplo "para 3 días".', {
        t: 'actions',
        items: [1, 3, 5, 7].map((n) => ({ label: `${n} ${n === 1 ? 'día' : 'días'}`, fn: () => enviar(`para ${n} días`) })),
      }];
    }
    if (dias < 1 || dias > 365) return ['Indica un número de días válido (entre 1 y 365).'];

    const bloques = [];
    conCalculo.slice(0, 3).forEach((p) => {
      const d = guiaDe(p.id).dosis;
      bloques.push({ t: 'h', text: p.nombre });
      if (d.duracionMaximaDias && dias > d.duracionMaximaDias) {
        bloques.push(`Sin indicación médica no se recomienda usarlo más de ${d.duracionMaximaDias} días seguidos, así que no calculo ${dias} días. Si necesitas más tiempo, consulta a un médico.`);
        return;
      }
      const porDia = d.calculo.unidadesPorToma * d.calculo.tomasPorDia;
      const unidades = porDia * dias;
      const env = empaque(p);
      const items = [
        `Estimación: ${d.calculo.unidadesPorToma} por toma, ${d.calculo.tomasPorDia} ${d.calculo.tomasPorDia === 1 ? 'vez' : 'veces'} al día (${porDia} al día).`,
        `Para ${dias} ${dias === 1 ? 'día' : 'días'}: ${unidades} ${env ? env.unidad : 'unidades'}.`,
      ];
      const acciones = [];
      if (env) {
        const envases = Math.ceil(unidades / env.cantidad);
        items.push(`Necesitarías ${envases} ${envases === 1 ? 'envase' : 'envases'} de ${env.cantidad}.`);
        items.push(`Costo aproximado: ${dinero(envases * p.precio, p)}.`);
        if (envases > p.existencias) items.push(`Ahora solo hay ${p.existencias} disponibles.`);
        const aAgregar = Math.min(envases, p.existencias);
        if (aAgregar > 0) acciones.push({ label: `🛒 Agregar ${aAgregar} al carrito`, fn: () => agregar(p.id, aAgregar) });
      } else {
        items.push('No encuentro el tamaño del envase para calcular el costo.');
      }
      bloques.push({ t: 'ul', items });
      if (acciones.length) bloques.push({ t: 'actions', items: acciones });
    });
    bloques.push({ t: 'warn', text: 'Es una estimación con la dosis habitual, no una indicación médica. Tu dosis real puede ser distinta.' });
    bloques.push({ t: 'small', text: AVISO });
    return bloques;
  }

  function recomendar(targets) {
    if (!targets.length) return pedirProducto();
    const bloques = [];
    targets.slice(0, 2).forEach((p) => {
      const g = guiaDe(p.id);
      bloques.push({ t: 'h', text: p.nombre });
      if (!g) {
        bloques.push('No tengo recomendaciones para este producto. Consulta al químico farmacéutico.');
        return;
      }
      if (lista(g.recomendaciones).length) bloques.push({ t: 'ul', items: lista(g.recomendaciones) });
      const comp = lista(g.complementarios).map(findProductById).filter(Boolean);
      const alt = lista(g.alternativas).map(findProductById).filter(Boolean);
      if (p.existencias === 0 && alt.length) {
        bloques.push(`${p.nombre} está agotado. Puedes preguntar al farmacéutico por: ${alt.map((a) => a.nombre).join(', ')}.`);
      }
      if (comp.length) {
        bloques.push({ t: 'strong', text: 'Podría combinar bien con:' });
        bloques.push({ t: 'ul', items: comp.map((c) => `${c.nombre}: ${dinero(c.precio, c)}, ${disponibilidad(c)}`) });
        const disponibles = comp.filter((c) => c.existencias > 0);
        if (disponibles.length) {
          bloques.push({ t: 'actions', items: disponibles.map((c) => ({ label: `🛒 ${c.nombre}`, fn: () => agregar(c.id, 1) })) });
        }
      }
      if (alt.length && p.existencias > 0) {
        bloques.push(`Si no puedes usar este producto, pregunta al farmacéutico si es opción: ${alt.map((a) => a.nombre).join(', ')}.`);
      }
    });
    bloques.push({ t: 'small', text: AVISO });
    return bloques;
  }

  function resumenProducto(p) {
    const bloques = [
      { t: 'h', text: p.nombre },
      { t: 'ul', items: [`Precio: ${dinero(p.precio, p)}`, `Disponibilidad: ${disponibilidad(p)}`, ...p.caracteristicas] },
    ];
    const acciones = [
      { label: '💊 Dosis y uso', fn: () => { fijarProducto(p.id); enviar('¿Cuál es la dosis y cada cuántas horas se toma?'); } },
      { label: '👍 Recomendaciones', fn: () => { fijarProducto(p.id); enviar('¿Qué me recomiendas con este producto?'); } },
    ];
    if (p.existencias > 0) acciones.push({ label: '🛒 Agregar', fn: () => agregar(p.id, 1) });
    bloques.push({ t: 'actions', items: acciones });
    return bloques;
  }

  function listarCategoria(cat) {
    const items = state.products.filter((p) => p.categoria === cat).map((p) => `${p.nombre}: ${dinero(p.precio, p)}, ${disponibilidad(p)}`);
    return [`Productos de ${cat}:`, { t: 'ul', items }];
  }

  function emergencia() {
    return [
      { t: 'warn', text: 'Si alguien tomó más de la dosis indicada, ingirió un producto que no debía o hay dificultad para respirar, dolor de pecho, desmayo o convulsiones: llama ya a la línea de emergencias (en Colombia, 123) o ve a urgencias. No esperes a que aparezcan síntomas.' },
      'Si tomaste de más a propósito, pide ayuda ahora mismo: llama al 123 o avisa a una persona cercana.',
    ];
  }

  function restringido() {
    return [
      'Para niños, embarazo, lactancia, alergias, enfermedades previas o si tomas otros medicamentos, no puedo darte una dosis: depende de la edad, el peso y tu situación, y un error puede ser peligroso.',
      'Pregunta a un médico o al químico farmacéutico de la droguería, o sigue la tabla de dosis de la etiqueta del producto.',
      'Sí puedo ayudarte con precios y totales.',
    ];
  }

  function ayuda() {
    return [
      'Hola, soy el asistente de Droguería Ermita. Puedo ayudarte con:',
      { t: 'ul', items: [
        'Precios y totales: "¿cuánto cuestan 3 paracetamol y 2 vitamina C?"',
        'Tu carrito: "¿cuánto es el total de mi carrito?"',
        'Uso y dosis habitual: "¿cada cuántas horas se toma el ibuprofeno?"',
        'Cuánto necesitas para un tratamiento: "paracetamol para 3 días"',
        'Recomendaciones según el producto que elijas',
      ] },
      { t: 'small', text: AVISO },
    ];
  }

  // ---------- Motor de respuestas ----------
  function responder(texto) {
    if (!state.products.length) return ['El catálogo aún no ha cargado. Inténtalo de nuevo en unos segundos.'];
    const t = norm(texto);
    if (RE.emergencia.test(t)) return emergencia();
    if (RE.saludo.test(t)) return ayuda();

    const encontrados = productosMencionados(texto);
    if (encontrados.length === 1) fijarProducto(encontrados[0].product.id);

    const dias = leerDias(t);
    const pideTratamiento = /tratamiento/.test(t)
      || (dias !== null && (chat.esperaDias || RE.dosis.test(t) || /necesit|tomar|durante/.test(t)
        || ((encontrados.length > 0 || chat.productoId) && !RE.total.test(t))));
    const pideDosis = RE.dosis.test(t);
    const pideRecomendacion = RE.recomendacion.test(t);
    chat.esperaDias = false;

    if ((pideTratamiento || pideDosis || pideRecomendacion) && RE.restringido.test(t)) return restringido();
    if (pideTratamiento) return tratamiento(objetivos(encontrados), dias);
    if (pideDosis) return dosis(objetivos(encontrados));
    if (pideRecomendacion) return recomendar(objetivos(encontrados));
    if (RE.barato.test(t)) return extremos(t);
    if (RE.presupuesto.test(t) && leerPresupuesto(t)) return presupuesto(t, encontrados);
    if (/carrito|pedido|lo que llevo|mi compra/.test(t)) return totalCarrito();
    if (encontrados.length && RE.total.test(t)) return respuestaCotizacion(encontrados, true);
    if (encontrados.length) return resumenProducto(encontrados[0].product);
    if (RE.total.test(t)) return totalCarrito();
    const cat = categoriaEn(t);
    if (cat) return listarCategoria(cat);
    return ['No estoy seguro de haber entendido. Prueba con una de estas ideas:', ...ayuda().slice(1)];
  }

  // ---------- Interfaz del chat ----------
  function renderBloque(b) {
    if (typeof b === 'string') {
      const p = document.createElement('p');
      p.textContent = b;
      return p;
    }
    if (b.t === 'ul') {
      const ul = document.createElement('ul');
      b.items.forEach((texto) => {
        const li = document.createElement('li');
        li.textContent = texto;
        ul.appendChild(li);
      });
      return ul;
    }
    if (b.t === 'actions') {
      const div = document.createElement('div');
      div.className = 'chat-actions';
      b.items.forEach((a) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-action';
        btn.textContent = a.label;
        btn.addEventListener('click', a.fn);
        div.appendChild(btn);
      });
      return div;
    }
    const nodo = document.createElement(b.t === 'h' || b.t === 'strong' ? 'strong' : 'p');
    nodo.className = { h: 'chat-heading', strong: 'chat-strong', warn: 'chat-warn', small: 'chat-small' }[b.t] || '';
    nodo.textContent = b.text;
    return nodo;
  }

  function addMessage(autor, bloques) {
    const item = document.createElement('div');
    item.className = `chat-msg chat-msg-${autor}`;
    bloques.forEach((b) => item.appendChild(renderBloque(b)));
    el.log.appendChild(item);
    while (el.log.children.length > MAX_MENSAJES) el.log.removeChild(el.log.firstChild);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function enviar(texto) {
    addMessage('user', [texto]);
    ensureGuides().then(() => addMessage('bot', responder(texto)));
  }

  function agregar(id, cantidad) {
    for (let i = 0; i < cantidad; i += 1) addToCart(id);
  }

  function fijarProducto(id) {
    chat.productoId = id;
    el.select.value = id;
  }

  function poblarSelect() {
    if (el.select.options.length - 1 === state.products.length) return;
    const actual = chat.productoId;
    el.select.length = 1;
    state.products.forEach((p) => {
      const op = document.createElement('option');
      op.value = p.id;
      op.textContent = p.nombre;
      el.select.appendChild(op);
    });
    el.select.value = actual;
  }

  function abrir() {
    poblarSelect();
    el.panel.hidden = false;
    el.toggle.setAttribute('aria-expanded', 'true');
    if (!el.log.children.length) addMessage('bot', ayuda());
    ensureGuides();
    el.input.focus();
  }

  function cerrar() {
    el.panel.hidden = true;
    el.toggle.setAttribute('aria-expanded', 'false');
    el.toggle.focus();
  }

  // Punto de entrada para el botón "Preguntar al asistente" del detalle de producto
  window.openAssistant = (id) => {
    abrir();
    const p = id ? findProductById(id) : null;
    if (!p) return;
    fijarProducto(p.id);
    addMessage('bot', [`Elegiste ${p.nombre}. ¿Qué quieres saber?`, accionesProducto(p),
      { t: 'actions', items: [{ label: '💊 Dosis y uso', fn: () => enviar('¿Cuál es la dosis y cada cuántas horas se toma?') }] }]);
  };

  el.toggle.addEventListener('click', () => (el.panel.hidden ? abrir() : cerrar()));
  el.close.addEventListener('click', cerrar);
  el.select.addEventListener('change', () => { chat.productoId = el.select.value; });
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = el.input.value.trim();
    if (!texto) return;
    el.input.value = '';
    enviar(texto);
  });
  el.panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrar();
  });
  el.chips.querySelectorAll('[data-chat-msg]').forEach((btn) => {
    btn.addEventListener('click', () => enviar(btn.dataset.chatMsg));
  });
})();
