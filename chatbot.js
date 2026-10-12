'use strict';

/**
 * Asistente de Droguería Ermita, guiado por botones (sin texto libre).
 * - Funciona 100 % en el navegador, sin servidor ni IA externa.
 * - Precios y existencias: lee `state.products` y `state.cart` de app.js. Solo modifica el
 *   carrito cuando la persona pulsa una opción de añadir (usa addToCart de app.js).
 * - Orientación de uso y dosis: lee guia-productos.json, un archivo aparte, para no cambiar
 *   el modelo compartido de producto de 9 campos.
 */
(function () {
  const AVISO = 'Información de referencia para adultos. No reemplaza la etiqueta del producto ni la consulta con un médico o químico farmacéutico.';
  const MAX_MENSAJES = 40;

  const ACCIONES = {
    precio: { etiqueta: '💰 ¿Cuánto cuesta?', pregunta: '¿De qué producto quieres saber el precio?' },
    agregar: { etiqueta: '🛒 Añadir al carrito', pregunta: '¿Qué producto quieres añadir al carrito?' },
    dosis: { etiqueta: '💊 Dosis', pregunta: '¿De qué producto quieres saber la dosis o el modo de uso?' },
    tratamiento: { etiqueta: '🧮 Tratamiento', pregunta: '¿Para qué producto quieres calcular un tratamiento?' },
    recomendacion: { etiqueta: '👍 Recomendación', pregunta: '¿De qué producto quieres una recomendación?' },
  };

  const chat = { guias: null, promesaGuias: null };

  const el = {
    toggle: document.getElementById('chatToggle'),
    panel: document.getElementById('chatPanel'),
    close: document.getElementById('chatClose'),
    log: document.getElementById('chatLog'),
    options: document.getElementById('chatOptions'),
  };
  if (!el.toggle || !el.panel || !el.log || !el.options) return;

  // ---------- Utilidades ----------
  const lista = (valor) => (Array.isArray(valor) ? valor.filter((x) => typeof x === 'string') : []);
  const guiaDe = (id) => (chat.guias ? chat.guias.productos[id] : undefined);
  const calculable = (p) => Boolean(guiaDe(p.id) && guiaDe(p.id).dosis);
  const dinero = (valor, producto) => formatPrice(valor, producto.moneda);
  const unidades = (n) => `${n} ${n === 1 ? 'unidad' : 'unidades'}`;

  function cantidadEnCarrito(id) {
    const item = state.cart.find((entry) => entry.id === id);
    return item ? item.cantidad : 0;
  }

  function disponibilidad(p) {
    const estado = getAvailabilityStatus(p.existencias, p.stockMinimo);
    if (estado === 'out') return 'agotado';
    if (estado === 'low') return `stock bajo (${p.existencias} disponibles)`;
    return `disponible (${p.existencias} unidades)`;
  }

  function empaque(p) {
    for (const c of p.caracteristicas) {
      const m = c.match(/x\s*(\d+)\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/);
      if (m) return { cantidad: parseInt(m[1], 10), unidad: m[2].toLowerCase() };
    }
    return null;
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
        avisos.push(`De ${p.nombre} solo hay ${p.existencias} disponibles; calculé con ${p.existencias}.`);
        q = p.existencias;
      }
      const subtotal = p.precio * q;
      totales[p.moneda] = (totales[p.moneda] || 0) + subtotal;
      lineas.push(`${q} × ${p.nombre}: ${formatPrice(subtotal, p.moneda)}`);
    });
    const total = Object.entries(totales).map(([m, v]) => formatPrice(v, m)).join(' + ');
    return { lineas, avisos, total };
  }

  function totalCarrito() {
    if (!state.cart.length) {
      return ['Tu carrito está vacío. Usa "🛒 Añadir al carrito" para agregar productos.'];
    }
    const items = state.cart.map((i) => ({ product: findProductById(i.id), qty: i.cantidad })).filter((i) => i.product);
    const c = cotizar(items);
    const bloques = ['Esto es lo que llevas en el carrito:', { t: 'ul', items: c.lineas }, { t: 'strong', text: `Total: ${c.total}` }];
    c.avisos.forEach((a) => bloques.push({ t: 'small', text: a }));
    return bloques;
  }

  function resumenPrecio(p) {
    const bloques = [
      { t: 'h', text: p.nombre },
      { t: 'ul', items: [`Precio por unidad: ${dinero(p.precio, p)}`, `Disponibilidad: ${disponibilidad(p)}`] },
    ];
    const cantidades = [2, 3, 5, 10].filter((n) => n <= p.existencias);
    if (cantidades.length) {
      bloques.push('¿Quieres calcular el total para varias unidades?');
      bloques.push({
        t: 'actions',
        items: cantidades.map((n) => ({
          label: unidades(n),
          fn: () => {
            addMessage('user', [unidades(n)]);
            responderBot(() => cotizacionCantidad(p, n));
          },
        })),
      });
    }
    bloques.push(...masOpciones(p, 'precio', false));
    return bloques;
  }

  function cotizacionCantidad(p, n) {
    const c = cotizar([{ product: p, qty: n }]);
    const q = Math.min(n, p.existencias);
    const bloques = [{ t: 'ul', items: c.lineas }, { t: 'strong', text: `Total: ${c.total}` }];
    c.avisos.forEach((a) => bloques.push({ t: 'small', text: a }));
    if (q > 0) bloques.push({ t: 'actions', items: [botonAgregar(p, q)] });
    return bloques;
  }

  // ---------- Añadir al carrito ----------
  function botonAgregar(p, n) {
    return {
      label: `🛒 Añadir ${unidades(n)} al carrito`,
      fn: () => {
        addMessage('user', [`Añadir ${unidades(n)}`]);
        responderBot(() => confirmarAgregado(p, n));
      },
    };
  }

  function preguntarCantidadAgregar(p) {
    const hueco = p.existencias - cantidadEnCarrito(p.id);
    if (hueco <= 0) {
      return [`Ya tienes en el carrito todas las unidades disponibles de ${p.nombre} (${p.existencias}).`];
    }
    const opciones = [1, 2, 3, 5].filter((n) => n <= hueco);
    if (hueco > 1 && hueco <= 10 && !opciones.includes(hueco)) opciones.push(hueco);
    return [
      `¿Cuántas unidades de ${p.nombre} quieres añadir? Puedes añadir hasta ${hueco}.`,
      {
        t: 'actions',
        items: opciones.map((n) => ({
          label: n === hueco && hueco > 1 ? `${n} (máximo)` : String(n),
          fn: () => {
            addMessage('user', [unidades(n)]);
            responderBot(() => confirmarAgregado(p, n));
          },
        })),
      },
    ];
  }

  function confirmarAgregado(p, n) {
    const antes = cantidadEnCarrito(p.id);
    for (let i = 0; i < n; i += 1) addToCart(p.id);
    const agregadas = cantidadEnCarrito(p.id) - antes;
    if (agregadas <= 0) return ['No pude añadir más unidades: ya llevas todas las disponibles.'];
    return [
      `Listo: añadí ${unidades(agregadas)} de ${p.nombre}. Ahora llevas ${cantidadEnCarrito(p.id)} en el carrito.`,
      { t: 'actions', items: [{
        label: '🧾 Ver total del carrito',
        fn: () => {
          addMessage('user', ['🧾 Total del carrito']);
          responderBot(totalCarrito);
        },
      }] },
    ];
  }

  // ---------- Dosis, tratamiento y recomendaciones ----------
  function preguntarAdulto(accion, p) {
    return [
      { t: 'warn', text: 'La dosis que muestro es solo para adultos.' },
      '¿La consulta es para un adulto sin embarazo, lactancia, alergias, enfermedades previas ni otros medicamentos?',
      { t: 'actions', items: [
        {
          label: 'Sí, es para un adulto',
          fn: () => {
            addMessage('user', ['Sí, es para un adulto']);
            responderBot(() => procesar(accion, p, true));
          },
        },
        {
          label: 'No o no estoy seguro',
          fn: () => {
            addMessage('user', ['No o no estoy seguro']);
            responderBot(restringido);
          },
        },
      ] },
    ];
  }

  function restringido() {
    return [
      'Para niños, embarazo, lactancia, alergias, enfermedades previas o si tomas otros medicamentos, no puedo darte una dosis: depende de la edad, el peso y tu situación, y un error puede ser peligroso.',
      'Pregunta a un médico o al químico farmacéutico de la droguería, o sigue la tabla de dosis de la etiqueta del producto.',
      'Con el menú de abajo sí puedo ayudarte con precios y con tu carrito.',
    ];
  }

  function dosis(p) {
    const g = guiaDe(p.id);
    const bloques = [{ t: 'h', text: p.nombre }];
    if (!g) {
      bloques.push('No tengo una guía de uso para este producto. Sigue la etiqueta o consulta al químico farmacéutico.');
      return bloques;
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
    if (g.dosis) {
      bloques.push({ t: 'warn', text: 'Esta es la dosis habitual de referencia, no una dosis personalizada ni una garantía de mejoría. Si los síntomas no mejoran en los plazos indicados, consulta a un profesional.' });
    }
    bloques.push({ t: 'small', text: AVISO });
    bloques.push(...masOpciones(p, 'dosis', true));
    return bloques;
  }

  function opcionesDias(p) {
    const max = guiaDe(p.id).dosis.duracionMaximaDias;
    if (!max) return [7, 15, 30];
    const dias = [1, 3, 5, 7].filter((n) => n <= max);
    return dias.length ? dias : [1];
  }

  function preguntarDias(p) {
    if (!calculable(p)) {
      return ['Para este producto no puedo estimar un tratamiento: sigue la etiqueta o consulta al químico farmacéutico.'];
    }
    const max = guiaDe(p.id).dosis.duracionMaximaDias;
    const bloques = [`¿Para cuántos días quieres calcular ${p.nombre}?`];
    if (max) bloques.push({ t: 'small', text: `Sin consultar a un médico no se recomienda usarlo más de ${max} días seguidos.` });
    bloques.push({
      t: 'actions',
      items: opcionesDias(p).map((n) => ({
        label: `${n} ${n === 1 ? 'día' : 'días'}`,
        fn: () => {
          addMessage('user', [`${n} ${n === 1 ? 'día' : 'días'}`]);
          responderBot(() => tratamiento(p, n));
        },
      })),
    });
    return bloques;
  }

  function tratamiento(p, dias) {
    const d = guiaDe(p.id).dosis;
    const bloques = [{ t: 'h', text: p.nombre }];
    if (d.duracionMaximaDias && dias > d.duracionMaximaDias) {
      bloques.push(`Sin indicación médica no se recomienda usarlo más de ${d.duracionMaximaDias} días seguidos. Si necesitas más tiempo, consulta a un médico.`);
      return bloques;
    }
    const porDia = d.calculo.unidadesPorToma * d.calculo.tomasPorDia;
    const total = porDia * dias;
    const env = empaque(p);
    const items = [
      `Estimación: ${d.calculo.unidadesPorToma} por toma, ${d.calculo.tomasPorDia} ${d.calculo.tomasPorDia === 1 ? 'vez' : 'veces'} al día (${porDia} al día).`,
      `Para ${dias} ${dias === 1 ? 'día' : 'días'}: ${total} ${env ? env.unidad : 'unidades'}.`,
    ];
    const acciones = [];
    if (env) {
      const envases = Math.ceil(total / env.cantidad);
      items.push(`Necesitarías ${envases} ${envases === 1 ? 'envase' : 'envases'} de ${env.cantidad}.`);
      items.push(`Costo aproximado: ${dinero(envases * p.precio, p)}.`);
      if (envases > p.existencias) items.push(`Ahora solo hay ${p.existencias} disponibles.`);
      const aAgregar = Math.min(envases, p.existencias);
      if (aAgregar > 0) acciones.push(botonAgregar(p, aAgregar));
    } else {
      items.push('No encuentro el tamaño del envase para calcular el costo.');
    }
    bloques.push({ t: 'ul', items });
    if (acciones.length) bloques.push({ t: 'actions', items: acciones });
    bloques.push({ t: 'warn', text: 'Es una estimación con la dosis habitual, no una indicación médica. Tu dosis real puede ser distinta.' });
    bloques.push({ t: 'small', text: AVISO });
    bloques.push(...masOpciones(p, 'tratamiento', true));
    return bloques;
  }

  function recomendar(p) {
    const g = guiaDe(p.id);
    const bloques = [{ t: 'h', text: p.nombre }];
    if (!g) {
      bloques.push('No tengo recomendaciones para este producto. Consulta al químico farmacéutico.');
      return bloques;
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
        bloques.push({
          t: 'actions',
          items: disponibles.map((c) => ({
            label: `🛒 Añadir ${c.nombre}`,
            fn: () => {
              addMessage('user', [`Añadir ${c.nombre}`]);
              responderBot(() => confirmarAgregado(c, 1));
            },
          })),
        });
      }
    }
    if (alt.length && p.existencias > 0) {
      bloques.push(`Si no puedes usar este producto, pregunta al farmacéutico si es opción: ${alt.map((a) => a.nombre).join(', ')}.`);
    }
    bloques.push({ t: 'small', text: AVISO });
    bloques.push(...masOpciones(p, 'recomendacion', false));
    return bloques;
  }

  // ---------- Flujo guiado ----------
  // `confirmado` indica que la persona ya confirmó que la consulta es para un adulto.
  function masOpciones(p, excluir, confirmado) {
    const items = [];
    const agregarOpcion = (accion, visible) => {
      if (visible && accion !== excluir) {
        items.push({ label: ACCIONES[accion].etiqueta, fn: () => accionSobre(accion, p, confirmado) });
      }
    };
    agregarOpcion('precio', true);
    agregarOpcion('dosis', true);
    agregarOpcion('recomendacion', true);
    agregarOpcion('tratamiento', calculable(p));
    agregarOpcion('agregar', p.existencias > 0);
    return [{ t: 'small', text: 'Más opciones para este producto:' }, { t: 'actions', items }];
  }

  function procesar(accion, p, confirmado) {
    if ((accion === 'dosis' || accion === 'tratamiento') && calculable(p) && !confirmado) {
      return preguntarAdulto(accion, p);
    }
    switch (accion) {
      case 'precio': return resumenPrecio(p);
      case 'agregar': return preguntarCantidadAgregar(p);
      case 'dosis': return dosis(p);
      case 'tratamiento': return preguntarDias(p);
      case 'recomendacion': return recomendar(p);
      default: return ['No entendí esa opción. Elige una del menú de abajo.'];
    }
  }

  function accionSobre(accion, p, confirmado) {
    addMessage('user', [ACCIONES[accion].etiqueta]);
    responderBot(() => procesar(accion, p, confirmado));
  }

  function preguntarProducto(accion) {
    if (!state.products.length) return ['El catálogo aún no ha cargado. Inténtalo de nuevo en unos segundos.'];
    const productos = accion === 'tratamiento' ? state.products.filter(calculable) : state.products;
    if (!productos.length) return ['Esta opción no está disponible por ahora.'];
    const bloques = [ACCIONES[accion].pregunta];
    if (accion === 'tratamiento') {
      bloques.push({ t: 'small', text: 'Disponible para productos con dosis definida.' });
    }
    bloques.push({
      t: 'actions',
      items: productos.map((p) => {
        const agotado = accion === 'agregar' && p.existencias === 0;
        return {
          label: agotado ? `${p.nombre} (agotado)` : p.nombre,
          disabled: agotado,
          fn: () => {
            addMessage('user', [p.nombre]);
            responderBot(() => procesar(accion, p, false));
          },
        };
      }),
    });
    return bloques;
  }

  function responderBot(generar) {
    ensureGuides().then(() => addMessage('bot', generar()));
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
        if (a.disabled) {
          btn.disabled = true;
        } else {
          btn.addEventListener('click', a.fn);
        }
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
    // Las respuestas largas se leen desde su inicio; los mensajes de la persona van al final.
    el.log.scrollTop = autor === 'bot' ? Math.max(0, item.offsetTop - 8) : el.log.scrollHeight;
  }

  function bienvenida() {
    return [
      'Hola, soy el asistente de Droguería Ermita. Elige una opción del menú de abajo y te guío paso a paso.',
      { t: 'small', text: AVISO },
    ];
  }

  function abrir() {
    el.panel.hidden = false;
    el.toggle.setAttribute('aria-expanded', 'true');
    if (!el.log.children.length) addMessage('bot', bienvenida());
    ensureGuides();
    const primero = el.options.querySelector('button');
    if (primero) primero.focus();
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
    responderBot(() => [`Elegiste ${p.nombre}. ¿Qué quieres saber?`, { t: 'actions', items: masOpciones(p, null, false)[1].items }]);
  };

  el.toggle.addEventListener('click', () => (el.panel.hidden ? abrir() : cerrar()));
  el.close.addEventListener('click', cerrar);
  el.panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrar();
  });
  el.options.querySelectorAll('[data-chat-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const accion = btn.dataset.chatAction;
      addMessage('user', [btn.textContent.trim()]);
      responderBot(() => (accion === 'total' ? totalCarrito() : preguntarProducto(accion)));
    });
  });
})();
