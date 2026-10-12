'use strict';

/**
 * Sección "Administrar inventario" (interfaz de la importación desde Excel).
 * - El archivo se lee en el navegador con SheetJS; nunca se envía a ningún servidor.
 * - La validación vive en importador-excel.js; aquí solo se muestra la vista previa y,
 *   tras la confirmación, se entrega el lote validado a replaceCatalog() de app.js.
 * - El cambio solo afecta a esta pestaña: GitHub Pages no guarda inventario. Para publicarlo
 *   hay que descargar productos.json y reemplazar ese archivo en el repositorio.
 */
(function () {
  const TITULO_CATALOGO = document.title;
  // Primero la copia local (recomendada para producción); si no existe, la CDN oficial de SheetJS.
  const URLS_XLSX = [
    'vendor/xlsx.full.min.js',
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  ];
  const TAMANO_MAXIMO = 5 * 1024 * 1024;
  const MAX_FILAS_TABLA = 200;
  const ETIQUETAS = {
    id: 'ID',
    nombre: 'Nombre',
    categoria: 'Categoría',
    caracteristicas: 'Características',
    precio: 'Precio',
    moneda: 'Moneda',
    existencias: 'Existencias',
    stockMinimo: 'Stock mínimo',
    imagen: 'Imagen',
  };
  const INSTRUCCIONES = [
    ['Columna', '¿Obligatoria?', 'Qué escribir', 'Ejemplo'],
    ['id', 'Sí', 'Identificador único del producto, sin espacios. Si ya existe en el catálogo se actualiza; si no existe se agrega como producto nuevo.', 'MED-009'],
    ['nombre', 'Sí', 'Nombre visible del producto.', 'Gel antibacterial 250 ml'],
    ['categoria', 'Sí', 'Categoría usada en los filtros.', 'Cuidado personal'],
    ['caracteristicas', 'Sí (puede quedar vacía)', 'Características separadas por punto y coma (;).', 'Frasco 250 ml; Con aloe vera'],
    ['precio', 'Sí', 'Número sin símbolos ni separador de miles (hasta 2 decimales).', '9500'],
    ['moneda', 'Sí', 'Código de 3 letras. Debe ser el mismo en todo el catálogo.', 'COP'],
    ['existencias', 'Sí', 'Unidades disponibles: entero igual o mayor que 0.', '40'],
    ['stockMinimo', 'Sí', 'Umbral para marcar stock bajo: entero igual o mayor que 0.', '10'],
    ['imagen', 'No', 'Ruta de la imagen dentro del sitio o URL https. Si se deja vacía, un producto existente conserva su imagen y uno nuevo usa images/sin-imagen.svg.', 'images/gel-antibacterial.jpg'],
    [],
    ['Notas'],
    ['• Escribe los productos en la hoja "Productos", una fila por producto, debajo de los encabezados.'],
    ['• No cambies los nombres de las columnas.'],
    ['• La importación no elimina productos: los que no aparezcan en el archivo se conservan.'],
    ['• Antes de aplicar cualquier cambio verás una vista previa y tendrás que confirmar.'],
  ];

  const $ = (id) => document.getElementById(id);
  const el = {
    catalogo: $('catalogView'),
    pie: $('siteFooter'),
    vista: $('adminView'),
    titulo: $('adminTitle'),
    mensaje: $('adminMessage'),
    sinPublicar: $('adminUnsaved'),
    plantilla: $('downloadTemplateBtn'),
    actual: $('downloadCurrentBtn'),
    archivo: $('excelFile'),
    permitirNuevos: $('allowNew'),
    estadoArchivo: $('fileStatus'),
    vistaPrevia: $('previewSection'),
    tituloPrevia: $('previewTitle'),
    archivoPrevia: $('previewFile'),
    resumen: $('previewSummary'),
    veredicto: $('previewVerdict'),
    errores: $('previewErrors'),
    avisos: $('previewWarnings'),
    nuevos: $('previewNew'),
    actualizaciones: $('previewUpdates'),
    sinCambios: $('previewUnchanged'),
    confirmar: $('confirmImportBtn'),
    cancelar: $('cancelImportBtn'),
    descargarJson: $('downloadJsonBtn'),
  };
  if (!el.vista) return;

  const estado = {
    filas: null,
    filaInicial: 1,
    nombreArchivo: '',
    hoja: '',
    resultado: null,
    promesaXlsx: null,
    token: 0,
    sinDescargar: false,
  };

  // ---------- Utilidades de DOM ----------
  function crear(etiqueta, contenido, clase) {
    const nodo = document.createElement(etiqueta);
    if (clase) nodo.className = clase;
    if (contenido !== undefined && contenido !== null) nodo.textContent = contenido;
    return nodo;
  }

  function vaciar(nodo) {
    while (nodo.firstChild) nodo.removeChild(nodo.firstChild);
  }

  function mostrarMensaje(texto, tipo) {
    el.mensaje.hidden = !texto;
    el.mensaje.className = `admin-alert admin-alert-${tipo || 'info'}`;
    el.mensaje.textContent = texto || '';
  }

  function descargar(nombre, contenido, tipo) {
    const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Vistas (catálogo / administración) ----------
  function mostrarVista() {
    const admin = window.location.hash === '#administrar';
    el.catalogo.hidden = admin;
    el.pie.hidden = admin;
    el.vista.hidden = !admin;
    document.body.classList.toggle('admin-mode', admin);
    document.title = admin ? 'Administrar inventario - Droguería Ermita' : TITULO_CATALOGO;
    if (admin) {
      cargarSheetJS().catch(() => {});
      el.titulo.focus();
    }
  }

  function actualizarDisponibilidad() {
    const listo = Boolean(state.catalogoCargado);
    el.archivo.disabled = !listo;
    el.actual.disabled = !listo;
    el.descargarJson.disabled = !listo;
    el.estadoArchivo.textContent = listo ? '' : 'El catálogo actual todavía no está cargado; no se puede importar hasta que cargue.';
  }

  function actualizarAvisoSinPublicar() {
    el.sinPublicar.hidden = !estado.sinDescargar;
  }

  // ---------- Biblioteca SheetJS (carga diferida) ----------
  function cargarScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error(url));
      };
      document.head.appendChild(script);
    });
  }

  function cargarSheetJS() {
    if (window.XLSX) return Promise.resolve();
    if (!estado.promesaXlsx) {
      estado.promesaXlsx = (async () => {
        for (const url of URLS_XLSX) {
          try {
            await cargarScript(url);
            if (window.XLSX) return;
          } catch (error) {
            // se prueba la siguiente fuente
          }
        }
        estado.promesaXlsx = null;
        throw new Error('No se pudo cargar SheetJS.');
      })();
    }
    return estado.promesaXlsx;
  }

  function errorBiblioteca() {
    mostrarMensaje('No se pudo cargar la biblioteca para leer Excel (SheetJS). Revisa tu conexión o copia xlsx.full.min.js en la carpeta vendor/ del sitio (ver README).', 'error');
    el.estadoArchivo.textContent = '';
  }

  // ---------- Descargas de Excel ----------
  async function descargarPlantilla() {
    try {
      await cargarSheetJS();
    } catch (error) {
      errorBiblioteca();
      return;
    }
    const columnas = ImportadorExcel.COLUMNAS;
    const hoja = XLSX.utils.aoa_to_sheet([columnas]);
    hoja['!cols'] = columnas.map((c) => ({ wch: ['nombre', 'caracteristicas', 'imagen'].includes(c) ? 30 : 16 }));
    const instrucciones = XLSX.utils.aoa_to_sheet(INSTRUCCIONES);
    instrucciones['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 80 }, { wch: 30 }];
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Productos');
    XLSX.utils.book_append_sheet(libro, instrucciones, 'Instrucciones');
    XLSX.writeFile(libro, 'plantilla-inventario.xlsx');
  }

  async function descargarInventarioActual() {
    try {
      await cargarSheetJS();
    } catch (error) {
      errorBiblioteca();
      return;
    }
    const columnas = ImportadorExcel.COLUMNAS;
    const filas = state.products.map((p) => [
      p.id, p.nombre, p.categoria, p.caracteristicas.join('; '), p.precio, p.moneda, p.existencias, p.stockMinimo, p.imagen,
    ]);
    const hoja = XLSX.utils.aoa_to_sheet([columnas, ...filas]);
    hoja['!cols'] = columnas.map((c) => ({ wch: ['nombre', 'caracteristicas', 'imagen'].includes(c) ? 30 : 16 }));
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Productos');
    XLSX.writeFile(libro, 'inventario-actual.xlsx');
  }

  function descargarJson() {
    descargar('productos.json', `${JSON.stringify(state.products, null, 2)}\n`, 'application/json');
    estado.sinDescargar = false;
    actualizarAvisoSinPublicar();
  }

  // ---------- Lectura y evaluación del archivo ----------
  function limpiarVistaPrevia(reiniciarArchivo) {
    estado.filas = null;
    estado.resultado = null;
    el.vistaPrevia.hidden = true;
    [el.resumen, el.veredicto, el.errores, el.avisos, el.nuevos, el.actualizaciones, el.sinCambios].forEach(vaciar);
    el.confirmar.disabled = true;
    if (reiniciarArchivo) {
      el.archivo.value = '';
      el.estadoArchivo.textContent = '';
    }
  }

  function falloArchivo(texto) {
    el.estadoArchivo.textContent = '';
    mostrarMensaje(texto, 'error');
  }

  async function alElegirArchivo() {
    const archivo = el.archivo.files[0];
    estado.token += 1;
    const token = estado.token;
    limpiarVistaPrevia(false);
    mostrarMensaje('');
    if (!archivo) return;
    if (!/\.xlsx$/i.test(archivo.name)) {
      falloArchivo('Elige un archivo Excel con extensión .xlsx.');
      return;
    }
    if (archivo.size > TAMANO_MAXIMO) {
      falloArchivo('El archivo pesa más de 5 MB. Divide la carga en archivos más pequeños.');
      return;
    }

    el.estadoArchivo.textContent = `Leyendo "${archivo.name}"…`;
    try {
      await cargarSheetJS();
    } catch (error) {
      errorBiblioteca();
      return;
    }

    let filas;
    let filaInicial;
    let hoja;
    try {
      const libro = XLSX.read(await archivo.arrayBuffer(), { type: 'array' });
      hoja = libro.SheetNames.includes('Productos') ? 'Productos' : libro.SheetNames[0];
      const datos = libro.Sheets[hoja];
      if (!datos || !datos['!ref']) {
        falloArchivo(`La hoja "${hoja}" está vacía.`);
        return;
      }
      filaInicial = XLSX.utils.decode_range(datos['!ref']).s.r + 1;
      filas = XLSX.utils.sheet_to_json(datos, { header: 1, raw: true, defval: '', blankrows: true });
    } catch (error) {
      console.error('No se pudo leer el Excel:', error);
      falloArchivo('No se pudo leer el archivo. Comprueba que sea un Excel .xlsx válido y que no esté protegido con contraseña.');
      return;
    }
    if (token !== estado.token) return; // se eligió otro archivo mientras tanto

    estado.filas = filas;
    estado.filaInicial = filaInicial;
    estado.nombreArchivo = archivo.name;
    estado.hoja = hoja;
    el.estadoArchivo.textContent = '';
    evaluar();
  }

  function evaluar() {
    if (!estado.filas) return;
    estado.resultado = ImportadorExcel.convertirFilas(estado.filas, state.products, {
      permitirNuevos: el.permitirNuevos.checked,
      filaInicial: estado.filaInicial,
    });
    renderVistaPrevia(estado.resultado);
  }

  // ---------- Vista previa ----------
  function tabla(titulo, columnas, filas) {
    const contenedor = crear('div', null, 'table-scroll');
    contenedor.setAttribute('role', 'region');
    contenedor.setAttribute('aria-label', titulo);
    contenedor.tabIndex = 0;
    const t = crear('table', null, 'admin-table');
    t.appendChild(crear('caption', titulo));
    const cabecera = crear('thead');
    const filaCabecera = crear('tr');
    columnas.forEach((c) => {
      const th = crear('th', c);
      th.setAttribute('scope', 'col');
      filaCabecera.appendChild(th);
    });
    cabecera.appendChild(filaCabecera);
    t.appendChild(cabecera);
    const cuerpo = crear('tbody');
    filas.slice(0, MAX_FILAS_TABLA).forEach((fila) => {
      const tr = crear('tr');
      fila.forEach((celda) => {
        const td = crear('td');
        if (typeof celda === 'object' && celda !== null) td.appendChild(celda);
        else td.textContent = String(celda);
        tr.appendChild(td);
      });
      cuerpo.appendChild(tr);
    });
    t.appendChild(cuerpo);
    contenedor.appendChild(t);
    const fragmento = document.createDocumentFragment();
    fragmento.appendChild(contenedor);
    if (filas.length > MAX_FILAS_TABLA) {
      fragmento.appendChild(crear('p', `Se muestran las primeras ${MAX_FILAS_TABLA} de ${filas.length} filas.`, 'admin-note'));
    }
    return fragmento;
  }

  function formatearValor(campo, valor, moneda) {
    if (campo === 'caracteristicas') return valor.length ? valor.join('; ') : '(vacío)';
    if (campo === 'precio') return formatPrice(valor, moneda);
    return valor === '' ? '(vacío)' : String(valor);
  }

  function celdaCambios(u) {
    const lista = crear('ul');
    const cambioMoneda = u.cambios.find((c) => c.campo === 'moneda');
    const monedaAntes = cambioMoneda ? cambioMoneda.antes : u.producto.moneda;
    u.cambios.forEach((c) => {
      const item = crear('li');
      item.appendChild(crear('strong', `${ETIQUETAS[c.campo]}: `));
      item.appendChild(crear('span', formatearValor(c.campo, c.antes, monedaAntes), 'change-before'));
      item.appendChild(document.createTextNode(' → '));
      item.appendChild(crear('span', formatearValor(c.campo, c.despues, u.producto.moneda), 'change-after'));
      lista.appendChild(item);
    });
    return lista;
  }

  function renderVistaPrevia(r) {
    [el.resumen, el.veredicto, el.errores, el.avisos, el.nuevos, el.actualizaciones, el.sinCambios].forEach(vaciar);
    el.vistaPrevia.hidden = false;
    el.archivoPrevia.textContent = `Archivo: ${estado.nombreArchivo} · Hoja: ${estado.hoja}`;

    [
      ['Filas leídas', r.filasLeidas, false],
      ['Nuevos', r.nuevos.length, false],
      ['Se actualizarán', r.actualizaciones.length, false],
      ['Sin cambios', r.sinCambios.length, false],
      ['Errores', r.errores.length, r.errores.length > 0],
    ].forEach(([etiqueta, cantidad, esError]) => {
      const item = crear('div', null, `summary-item${esError ? ' is-error' : ''}`);
      item.appendChild(crear('strong', String(cantidad)));
      item.appendChild(crear('span', etiqueta));
      el.resumen.appendChild(item);
    });

    const cambios = r.nuevos.length + r.actualizaciones.length;
    let texto;
    let tipo;
    if (r.errores.length > 0) {
      texto = `No se puede importar: corrige ${r.errores.length} error(es) en el Excel y vuelve a cargarlo. No se aplicó nada.`;
      tipo = 'error';
    } else if (cambios === 0) {
      texto = 'No hay cambios para aplicar: el archivo coincide con el catálogo actual.';
      tipo = 'info';
    } else {
      texto = 'Todo en orden. Revisa los cambios y confirma para aplicarlos.';
      tipo = 'success';
    }
    el.veredicto.appendChild(crear('p', texto, `admin-alert admin-alert-${tipo}`));

    if (r.errores.length > 0) {
      el.errores.appendChild(tabla(
        `Errores (${r.errores.length})`,
        ['Fila', 'Campo', 'Problema'],
        r.errores.map((e) => [e.fila === null ? '—' : e.fila, e.campo || '—', e.mensaje]),
      ));
    }

    if (r.advertencias.length > 0) {
      el.avisos.appendChild(crear('h4', 'Avisos (no bloquean la importación)'));
      const lista = crear('ul', null, 'admin-list');
      r.advertencias.forEach((a) => lista.appendChild(crear('li', a)));
      el.avisos.appendChild(lista);
    }

    if (r.nuevos.length > 0) {
      el.nuevos.appendChild(tabla(
        `Productos nuevos (${r.nuevos.length})`,
        ['Fila', 'ID', 'Nombre', 'Categoría', 'Precio', 'Existencias', 'Stock mínimo'],
        r.nuevos.map(({ fila, producto: p }) => [fila, p.id, p.nombre, p.categoria, formatPrice(p.precio, p.moneda), p.existencias, p.stockMinimo]),
      ));
      el.nuevos.appendChild(crear('p', 'Estos ids no existen en el catálogo actual. Si alguno es un error de escritura, corrige el Excel antes de confirmar.', 'admin-note'));
    }

    if (r.actualizaciones.length > 0) {
      el.actualizaciones.appendChild(tabla(
        `Productos que se actualizarán (${r.actualizaciones.length})`,
        ['Fila', 'ID', 'Producto', 'Cambios (antes → después)'],
        r.actualizaciones.map((u) => [u.fila, u.id, u.nombre, celdaCambios(u)]),
      ));
    }

    if (r.sinCambios.length > 0) {
      el.sinCambios.appendChild(crear('p', `${r.sinCambios.length} producto(s) del archivo ya coinciden con el catálogo y no tienen cambios.`, 'admin-note'));
    }

    el.confirmar.disabled = r.errores.length > 0 || cambios === 0;
    el.confirmar.textContent = cambios > 0 ? `Confirmar importación (${cambios} cambio${cambios === 1 ? '' : 's'})` : 'Confirmar importación';
    el.tituloPrevia.focus();
  }

  // ---------- Confirmación ----------
  function confirmarImportacion() {
    const r = estado.resultado;
    const cambios = r ? r.nuevos.length + r.actualizaciones.length : 0;
    if (!r || r.errores.length > 0 || !r.productosResultantes || cambios === 0) return;

    // Segunda comprobación con el mismo validador que usa loadProducts().
    const { valid, errors } = validateProducts(r.productosResultantes);
    if (errors.length > 0) {
      mostrarMensaje(`No se aplicó la importación: ${errors[0]}`, 'error');
      return;
    }

    const ajustes = replaceCatalog(valid);
    estado.sinDescargar = true;
    const texto = `Importación aplicada: ${r.nuevos.length} producto(s) nuevo(s) y ${r.actualizaciones.length} actualizado(s). El catálogo ya muestra los cambios en este navegador.`;
    limpiarVistaPrevia(true);
    mostrarMensaje(ajustes.length > 0 ? `${texto} ${ajustes.join(' ')}` : texto, 'success');
    actualizarAvisoSinPublicar();
    el.titulo.focus();
  }

  function cancelarImportacion() {
    limpiarVistaPrevia(true);
    mostrarMensaje('Importación cancelada. No se cambió nada.', 'info');
  }

  // ---------- Eventos ----------
  window.addEventListener('hashchange', mostrarVista);
  document.addEventListener('catalogo-cargado', actualizarDisponibilidad);
  window.addEventListener('beforeunload', (e) => {
    if (estado.sinDescargar) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  el.plantilla.addEventListener('click', descargarPlantilla);
  el.actual.addEventListener('click', descargarInventarioActual);
  el.descargarJson.addEventListener('click', descargarJson);
  el.archivo.addEventListener('change', alElegirArchivo);
  el.permitirNuevos.addEventListener('change', evaluar);
  el.confirmar.addEventListener('click', confirmarImportacion);
  el.cancelar.addEventListener('click', cancelarImportacion);

  mostrarVista();
  actualizarDisponibilidad();
  actualizarAvisoSinPublicar();
}());
