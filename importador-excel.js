'use strict';

/**
 * Adaptador de importación desde Excel (sin interfaz ni dependencias).
 * Recibe las filas ya leídas del archivo (lista de listas: encabezados + datos) y el
 * catálogo actual, y devuelve el lote completo validado y clasificado. No toca el DOM,
 * no lee archivos y no modifica el catálogo: eso lo decide la interfaz tras la confirmación.
 *
 * Contrato: entrega Product[] con los nueve campos del modelo compartido.
 * Regla de lote: si hay un solo error, no se entrega ningún producto (`productosResultantes`
 * queda en null), de modo que ninguna fila inválida pueda colarse parcialmente.
 */
(function (global) {
  const COLUMNAS_REQUERIDAS = ['id', 'nombre', 'categoria', 'caracteristicas', 'precio', 'moneda', 'existencias', 'stockMinimo'];
  const COLUMNAS_OPCIONALES = ['imagen'];
  const COLUMNAS = [...COLUMNAS_REQUERIDAS, ...COLUMNAS_OPCIONALES];
  const IMAGEN_PREDETERMINADA = 'images/sin-imagen.svg';
  const LIMITES = {
    filas: 5000,
    id: 40,
    nombre: 120,
    categoria: 60,
    caracteristica: 100,
    imagen: 300,
    precio: 1e9,
    unidades: 1e6,
  };

  // "Stock mínimo", "stock_minimo" y "STOCKMINIMO" se aceptan como "stockMinimo".
  const clave = (texto) => String(texto).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_-]+/g, '');
  const CLAVES = Object.fromEntries(COLUMNAS.map((c) => [clave(c), c]));

  function texto(celda) {
    if (celda === null || celda === undefined) return '';
    return String(celda).trim();
  }

  // ---------- Lectura de valores ----------
  function leerNumero(celda) {
    if (typeof celda === 'number') {
      return Number.isFinite(celda) ? { valor: celda } : { error: 'debe ser un número finito' };
    }
    const t = texto(celda);
    if (t === '') return { error: 'es obligatorio' };
    if (/^-/.test(t)) return { error: 'no puede ser negativo' };
    // "18.900" se leería como 18,9: se pide escribirlo sin separador de miles.
    if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
      return { error: `"${t}" parece usar separador de miles; escríbelo sin puntos ni comas (por ejemplo 18900)` };
    }
    if (/^\d+([.,]\d+)?$/.test(t)) return { valor: Number(t.replace(',', '.')) };
    return { error: `"${t}" no es un número válido (sin símbolos como $ ni espacios)` };
  }

  function leerEntero(celda) {
    if (typeof celda === 'number') {
      if (!Number.isFinite(celda)) return { error: 'debe ser un número finito' };
      if (celda < 0) return { error: 'no puede ser negativo' };
      if (!Number.isInteger(celda)) return { error: `${celda} no es un entero (sin decimales)` };
      return { valor: celda };
    }
    const t = texto(celda);
    if (t === '') return { error: 'es obligatorio' };
    if (/^-/.test(t)) return { error: 'no puede ser negativo' };
    if (/^\d+$/.test(t)) return { valor: parseInt(t, 10) };
    return { error: `"${t}" no es un entero válido (sin decimales, puntos ni símbolos)` };
  }

  function validarImagen(ruta) {
    if (ruta.length > LIMITES.imagen) return `es demasiado larga (máximo ${LIMITES.imagen} caracteres)`;
    if (/^https:\/\/\S+$/i.test(ruta)) return '';
    if (/^[\w\-./]+$/.test(ruta) && !ruta.includes('..') && !ruta.startsWith('/')) return '';
    return `"${ruta}" debe ser una ruta relativa como images/archivo.jpg (sin espacios ni tildes) o una URL https://`;
  }

  // ---------- Encabezados ----------
  function leerEncabezados(fila) {
    const indices = {};
    const errores = [];
    const advertencias = [];
    (fila || []).forEach((celda, columna) => {
      const t = texto(celda);
      if (t === '') return;
      const campo = CLAVES[clave(t)];
      if (!campo) {
        advertencias.push(`La columna "${t}" no es parte de la plantilla y se ignora.`);
      } else if (campo in indices) {
        errores.push({ fila: null, campo, mensaje: `La columna "${campo}" aparece repetida.` });
      } else {
        indices[campo] = columna;
      }
    });
    COLUMNAS_REQUERIDAS.forEach((campo) => {
      if (!(campo in indices)) errores.push({ fila: null, campo, mensaje: `Falta la columna obligatoria "${campo}".` });
    });
    return { indices, errores, advertencias };
  }

  // ---------- Comparación con el catálogo actual ----------
  const ORDEN_CAMPOS = ['id', 'nombre', 'categoria', 'caracteristicas', 'precio', 'moneda', 'existencias', 'stockMinimo', 'imagen'];

  function igual(campo, a, b) {
    return campo === 'caracteristicas' ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  }

  // Construye el producto con el orden de campos del modelo compartido.
  function ordenar(producto) {
    return Object.fromEntries(ORDEN_CAMPOS.map((campo) => [campo, producto[campo]]));
  }

  /**
   * @param {Array<Array>} filas  Encabezados en la primera fila y datos debajo.
   * @param {Product[]} catalogo  Catálogo actual (solo lectura).
   * @param {{permitirNuevos?: boolean, filaInicial?: number}} opciones
   *        filaInicial: número de fila de Excel de la primera fila recibida (por defecto 1).
   */
  function convertirFilas(filas, catalogo, opciones) {
    const permitirNuevos = !opciones || opciones.permitirNuevos !== false;
    const filaInicial = (opciones && opciones.filaInicial) || 1;
    const resultado = {
      errores: [],
      advertencias: [],
      nuevos: [],
      actualizaciones: [],
      sinCambios: [],
      filasLeidas: 0,
      productosResultantes: null,
    };
    const error = (fila, campo, mensaje) => resultado.errores.push({ fila, campo, mensaje });

    if (!Array.isArray(filas) || filas.length === 0) {
      error(null, null, 'El archivo no tiene datos. La primera fila debe contener los encabezados.');
      return resultado;
    }

    const encabezados = leerEncabezados(filas[0]);
    resultado.errores.push(...encabezados.errores);
    resultado.advertencias.push(...encabezados.advertencias);
    if (encabezados.errores.length > 0) return resultado;
    const { indices } = encabezados;

    if (filas.length - 1 > LIMITES.filas) {
      error(null, null, `El archivo tiene más de ${LIMITES.filas} filas. Divide la carga en archivos más pequeños.`);
      return resultado;
    }

    const existentes = new Map(catalogo.map((p) => [p.id, p]));
    const existentesMinuscula = new Map(catalogo.map((p) => [p.id.toLowerCase(), p]));
    const idsVistos = new Map(); // id en minúsculas -> { fila, id }
    const aplicables = []; // filas válidas, en el orden del archivo
    let usanImagenPredeterminada = 0;
    let conRutaDeImagen = false;

    for (let i = 1; i < filas.length; i += 1) {
      const celdas = filas[i] || [];
      if (celdas.every((c) => texto(c) === '')) continue; // fila vacía: se ignora
      resultado.filasLeidas += 1;
      const numeroFila = filaInicial + i;
      const celda = (campo) => (campo in indices ? celdas[indices[campo]] : undefined);
      const erroresFila = [];
      const fallo = (campo, mensaje) => erroresFila.push({ fila: numeroFila, campo, mensaje });
      const fila = {};

      // id
      fila.id = texto(celda('id'));
      if (fila.id === '') {
        fallo('id', 'es obligatorio');
      } else if (/\s/.test(fila.id) || fila.id.length > LIMITES.id) {
        fallo('id', `"${fila.id}" no puede tener espacios ni más de ${LIMITES.id} caracteres`);
      }

      // nombre y categoria
      [['nombre', LIMITES.nombre], ['categoria', LIMITES.categoria]].forEach(([campo, max]) => {
        fila[campo] = texto(celda(campo));
        if (fila[campo] === '') fallo(campo, 'es obligatorio');
        else if (fila[campo].length > max) fallo(campo, `es demasiado largo (máximo ${max} caracteres)`);
      });

      // caracteristicas: separadas por ";", puede quedar vacía
      fila.caracteristicas = texto(celda('caracteristicas')).split(';').map((c) => c.trim()).filter(Boolean);
      if (fila.caracteristicas.some((c) => c.length > LIMITES.caracteristica)) {
        fallo('caracteristicas', `cada característica admite máximo ${LIMITES.caracteristica} caracteres`);
      }

      // precio
      const precio = leerNumero(celda('precio'));
      if (precio.error) {
        fallo('precio', precio.error);
      } else if (precio.valor > LIMITES.precio) {
        fallo('precio', 'es demasiado alto; revisa que no tenga ceros de más');
      } else if (Math.abs(precio.valor * 100 - Math.round(precio.valor * 100)) > 1e-6) {
        fallo('precio', 'admite máximo 2 decimales');
      } else {
        fila.precio = precio.valor;
      }

      // moneda
      fila.moneda = texto(celda('moneda')).toUpperCase();
      if (!/^[A-Z]{3}$/.test(fila.moneda)) fallo('moneda', `"${texto(celda('moneda'))}" debe ser un código de 3 letras como COP o USD`);

      // existencias y stockMinimo
      ['existencias', 'stockMinimo'].forEach((campo) => {
        const n = leerEntero(celda(campo));
        if (n.error) fallo(campo, n.error);
        else if (n.valor > LIMITES.unidades) fallo(campo, 'es demasiado alto; revisa que no tenga ceros de más');
        else fila[campo] = n.valor;
      });

      // imagen (opcional)
      const imagen = texto(celda('imagen'));
      if (imagen !== '') {
        const problema = validarImagen(imagen);
        if (problema) fallo('imagen', problema);
        else {
          fila.imagen = imagen;
          if (!/^https:/i.test(imagen)) conRutaDeImagen = true;
        }
      }

      // id repetido dentro del archivo
      if (fila.id !== '') {
        const previo = idsVistos.get(fila.id.toLowerCase());
        if (previo) {
          const detalle = previo.id === fila.id
            ? `el id "${fila.id}" ya aparece en la fila ${previo.fila}`
            : `el id "${fila.id}" solo se diferencia en mayúsculas de "${previo.id}" (fila ${previo.fila})`;
          fallo('id', `${detalle}; cada producto debe tener un id único`);
        } else {
          idsVistos.set(fila.id.toLowerCase(), { fila: numeroFila, id: fila.id });
        }
      }

      // producto conocido o desconocido
      if (erroresFila.length === 0) {
        const actual = existentes.get(fila.id);
        if (!actual) {
          const parecido = existentesMinuscula.get(fila.id.toLowerCase());
          if (parecido) {
            fallo('id', `el id "${fila.id}" no existe, pero hay uno parecido: "${parecido.id}". Revisa las mayúsculas`);
          } else if (!permitirNuevos) {
            fallo('id', `producto desconocido: el id "${fila.id}" no existe en el catálogo actual`);
          }
        }
      }

      resultado.errores.push(...erroresFila);
      if (erroresFila.length === 0) aplicables.push({ numeroFila, fila });
    }

    // Clasificación de las filas válidas
    aplicables.forEach(({ numeroFila, fila }) => {
      const actual = existentes.get(fila.id);
      if (actual) {
        const combinado = ordenar({ ...actual, ...fila, imagen: fila.imagen || actual.imagen });
        const cambios = ORDEN_CAMPOS
          .filter((campo) => campo !== 'id' && !igual(campo, actual[campo], combinado[campo]))
          .map((campo) => ({ campo, antes: actual[campo], despues: combinado[campo] }));
        if (cambios.length === 0) resultado.sinCambios.push({ fila: numeroFila, id: fila.id });
        else resultado.actualizaciones.push({ fila: numeroFila, id: fila.id, nombre: combinado.nombre, cambios, producto: combinado });
      } else {
        const usaPredeterminada = !fila.imagen;
        if (usaPredeterminada) usanImagenPredeterminada += 1;
        resultado.nuevos.push({
          fila: numeroFila,
          producto: ordenar({ ...fila, imagen: fila.imagen || IMAGEN_PREDETERMINADA }),
          usaImagenPredeterminada: usaPredeterminada,
        });
      }
    });

    // Catálogo resultante (solo para comprobar reglas globales; no se entrega si hay errores)
    const reemplazos = new Map(resultado.actualizaciones.map((u) => [u.id, u.producto]));
    const final = [
      ...catalogo.map((p) => reemplazos.get(p.id) || p),
      ...resultado.nuevos.map((n) => n.producto),
    ];
    const monedas = [...new Set(final.map((p) => p.moneda))];
    if (monedas.length > 1) {
      error(null, 'moneda', `El catálogo quedaría con varias monedas (${monedas.join(', ')}). El carrito suma todo en una sola moneda: usa la misma en todos los productos.`);
    }

    // Advertencias (no bloquean)
    const nombres = new Map();
    final.forEach((p) => {
      const k = p.nombre.toLowerCase();
      if (!nombres.has(k)) nombres.set(k, []);
      nombres.get(k).push(p.id);
    });
    nombres.forEach((ids) => {
      if (ids.length > 1) resultado.advertencias.push(`Hay productos distintos con el mismo nombre (${ids.join(', ')}). Revisa que no sea un duplicado con otro id.`);
    });
    if (usanImagenPredeterminada > 0) {
      resultado.advertencias.push(`${usanImagenPredeterminada} producto(s) nuevo(s) no traen imagen y usarán ${IMAGEN_PREDETERMINADA}.`);
    }
    if (conRutaDeImagen) {
      resultado.advertencias.push('Las rutas de imagen no se pueden verificar desde aquí: sube los archivos a la carpeta images/ del sitio.');
    }
    const enArchivo = new Set(aplicables.map(({ fila }) => fila.id));
    const ausentes = catalogo.filter((p) => !enArchivo.has(p.id)).length;
    if (resultado.errores.length === 0 && ausentes > 0) {
      resultado.advertencias.push(`${ausentes} producto(s) del catálogo actual no aparecen en el archivo y se conservan sin cambios (la importación no elimina productos).`);
    }

    if (resultado.errores.length === 0) resultado.productosResultantes = final;
    return resultado;
  }

  global.ImportadorExcel = {
    COLUMNAS,
    COLUMNAS_REQUERIDAS,
    COLUMNAS_OPCIONALES,
    IMAGEN_PREDETERMINADA,
    LIMITES,
    convertirFilas,
  };
}(typeof window !== 'undefined' ? window : globalThis));
