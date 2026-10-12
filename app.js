'use strict';

/**
 * Estado global de la aplicación.
 * `products` es la única copia normalizada y validada del catálogo.
 * `cart` es una lista de demostración { id, cantidad } que vive solo en memoria:
 * no representa inventario compartido ni se sincroniza con productos.json.
 */
const state = {
  products: [],
  filteredProducts: [],
  cart: [],
};

// Elementos del DOM
const grid = document.getElementById('productGrid');
const searchInput = document.getElementById('searchInput');
const categoryFilter = document.getElementById('categoryFilter');
const statusFilter = document.getElementById('statusFilter');
const sortSelect = document.getElementById('sortSelect');
const resultsCount = document.getElementById('resultsCount');
const liveRegion = document.getElementById('liveRegion');
const toastContainer = document.getElementById('toastContainer');

const productModal = document.getElementById('productModal');
const modalBody = document.getElementById('modalBody');
const modalTitle = document.getElementById('modalTitle');
const closeModalBtn = document.getElementById('closeModalBtn');

const cartButton = document.getElementById('cartButton');
const cartCountEl = document.getElementById('cartCount');
const cartModal = document.getElementById('cartModal');
const cartBody = document.getElementById('cartBody');
const closeCartBtn = document.getElementById('closeCartBtn');

const CODIGO_MONEDA_REGEX = /^[A-Z]{3}$/;

/**
 * Único punto de carga de datos de la aplicación.
 * Hoy lee productos.json; más adelante puede reemplazarse por una importación
 * de Excel validada o por una llamada a una API, siempre que se conserve el
 * contrato Product[] y el paso de validación.
 */
async function loadProducts() {
  const response = await fetch('productos.json');
  if (!response.ok) {
    throw new Error(`No se pudo obtener productos.json (HTTP ${response.status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error('productos.json no contiene JSON válido.');
  }

  const { valid, errors } = validateProducts(data);
  if (errors.length > 0) {
    const detalle = new Error('El catálogo tiene datos inválidos y no se puede mostrar.');
    detalle.detalles = errors;
    throw detalle;
  }

  return valid;
}

/**
 * Valida la lista completa contra el modelo compartido de producto.
 * Devuelve los productos válidos y la lista de errores encontrados.
 * No se muestra parcialmente un catálogo inválido: si hay errores, el
 * llamador debe detenerse y mostrarlos en vez de usar `valid`.
 */
function validateProducts(data) {
  const errors = [];

  if (!Array.isArray(data)) {
    return { valid: [], errors: ['productos.json debe ser una lista de productos.'] };
  }

  const idsVistos = new Set();

  data.forEach((item, index) => {
    const prefijo = `Producto #${index + 1}`;

    if (typeof item !== 'object' || item === null) {
      errors.push(`${prefijo}: no es un objeto válido.`);
      return;
    }

    if (typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`${prefijo}: "id" es obligatorio y debe ser texto.`);
    } else if (idsVistos.has(item.id)) {
      errors.push(`${prefijo}: "id" duplicado (${item.id}).`);
    } else {
      idsVistos.add(item.id);
    }

    if (typeof item.nombre !== 'string' || item.nombre.trim() === '') {
      errors.push(`${prefijo} (${item.id || 's/n'}): "nombre" es obligatorio.`);
    }

    if (typeof item.categoria !== 'string' || item.categoria.trim() === '') {
      errors.push(`${prefijo} (${item.id || 's/n'}): "categoria" es obligatorio.`);
    }

    if (!Array.isArray(item.caracteristicas) || !item.caracteristicas.every((c) => typeof c === 'string')) {
      errors.push(`${prefijo} (${item.id || 's/n'}): "caracteristicas" debe ser una lista de texto (puede estar vacía).`);
    }

    if (typeof item.precio !== 'number' || !Number.isFinite(item.precio) || item.precio < 0) {
      errors.push(`${prefijo} (${item.id || 's/n'}): "precio" debe ser un número finito mayor o igual a 0.`);
    }

    if (typeof item.moneda !== 'string' || !CODIGO_MONEDA_REGEX.test(item.moneda)) {
      errors.push(`${prefijo} (${item.id || 's/n'}): "moneda" debe ser un código ISO 4217 en mayúsculas (ej. COP).`);
    }

    if (!Number.isInteger(item.existencias) || item.existencias < 0) {
      errors.push(`${prefijo} (${item.id || 's/n'}): "existencias" debe ser un entero no negativo.`);
    }

    if (!Number.isInteger(item.stockMinimo) || item.stockMinimo < 0) {
      errors.push(`${prefijo} (${item.id || 's/n'}): "stockMinimo" debe ser un entero no negativo.`);
    }

    if (typeof item.imagen !== 'string' || item.imagen.trim() === '') {
      errors.push(`${prefijo} (${item.id || 's/n'}): "imagen" es obligatorio (ruta relativa o URL HTTPS).`);
    }
  });

  return { valid: errors.length === 0 ? data : [], errors };
}

// Evalúa el estado de inventario a partir de existencias y stockMinimo
function getAvailabilityStatus(existencias, stockMinimo) {
  if (existencias === 0) return 'out';
  if (existencias > 0 && existencias <= stockMinimo) return 'low';
  return 'available';
}

function getStatusUI(statusKey) {
  const map = {
    out: { text: 'Agotado', class: 'status-out', orden: 2 },
    low: { text: 'Stock bajo', class: 'status-low', orden: 1 },
    available: { text: 'Disponible', class: 'status-available', orden: 0 },
  };
  return map[statusKey];
}

function formatPrice(price, currency) {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(price);
  } catch (error) {
    // Si la moneda no es reconocida por Intl, se evita romper el render.
    return `${price} ${currency}`;
  }
}

// Escapa texto no confiable antes de insertarlo como HTML
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function announce(message) {
  // Se vacía primero para que un mensaje repetido se vuelva a anunciar.
  liveRegion.textContent = '';
  setTimeout(() => {
    liveRegion.textContent = message;
  }, 50);
}

let toastTimer = null;

/**
 * Muestra una notificación breve en la esquina inferior derecha.
 * No bloquea la pantalla y desaparece sola; una nueva reemplaza a la anterior.
 * tipo: 'success' (por defecto) o 'warning'.
 */
function showToast(titulo, detalle, tipo = 'success') {
  toastContainer.innerHTML = '';

  const toast = document.createElement('div');
  toast.className = `toast toast-${tipo}`;

  const strong = document.createElement('strong');
  strong.textContent = titulo;
  toast.appendChild(strong);

  if (detalle) {
    const span = document.createElement('span');
    span.textContent = detalle;
    toast.appendChild(span);
  }

  toastContainer.appendChild(toast);
  announce(detalle ? `${titulo}. ${detalle}` : titulo);

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 3000);
}

// Genera las opciones de categoría a partir de los datos cargados
function initializeFilters(products) {
  const categories = [...new Set(products.map((p) => p.categoria))].sort((a, b) => a.localeCompare(b, 'es'));
  categories.forEach((cat) => {
    const option = document.createElement('option');
    option.value = cat;
    option.textContent = cat;
    categoryFilter.appendChild(option);
  });
}

// Ordena una copia de la lista según el criterio elegido
function sortProducts(products, sortKey) {
  const list = [...products];

  switch (sortKey) {
    case 'nombre-asc':
      list.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      break;
    case 'nombre-desc':
      list.sort((a, b) => b.nombre.localeCompare(a.nombre, 'es'));
      break;
    case 'precio-asc':
      list.sort((a, b) => a.precio - b.precio);
      break;
    case 'precio-desc':
      list.sort((a, b) => b.precio - a.precio);
      break;
    case 'disponibilidad':
      list.sort((a, b) => {
        const ordenA = getStatusUI(getAvailabilityStatus(a.existencias, a.stockMinimo)).orden;
        const ordenB = getStatusUI(getAvailabilityStatus(b.existencias, b.stockMinimo)).orden;
        return ordenA - ordenB || a.nombre.localeCompare(b.nombre, 'es');
      });
      break;
    default:
      break;
  }

  return list;
}

// Combina búsqueda, filtros y orden; vuelve a renderizar el resultado
function applyFilters() {
  const searchTerm = searchInput.value.toLowerCase().trim();
  const category = categoryFilter.value;
  const status = statusFilter.value;

  const filtered = state.products.filter((product) => {
    const textMatch = !searchTerm
      || product.nombre.toLowerCase().includes(searchTerm)
      || product.categoria.toLowerCase().includes(searchTerm)
      || product.caracteristicas.some((c) => c.toLowerCase().includes(searchTerm));

    const categoryMatch = category === 'all' || product.categoria === category;

    const productStatus = getAvailabilityStatus(product.existencias, product.stockMinimo);
    const statusMatch = status === 'all' || productStatus === status;

    return textMatch && categoryMatch && statusMatch;
  });

  state.filteredProducts = sortProducts(filtered, sortSelect.value);
  renderProducts(state.filteredProducts);
}

// Renderiza la cuadrícula de productos
function renderProducts(products) {
  grid.innerHTML = '';

  if (products.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>No se encontraron productos</h3>
        <p>Intenta ajustar la búsqueda, la categoría o el filtro de disponibilidad.</p>
      </div>
    `;
    resultsCount.textContent = '0 resultados';
    return;
  }

  resultsCount.textContent = `Mostrando ${products.length} producto${products.length !== 1 ? 's' : ''} de ${state.products.length}`;

  const fragment = document.createDocumentFragment();
  products.forEach((product) => {
    fragment.appendChild(createProductCard(product));
  });
  grid.appendChild(fragment);
}

// Construye la tarjeta de un producto. Todo el texto de datos se inserta escapado.
function createProductCard(product) {
  const statusKey = getAvailabilityStatus(product.existencias, product.stockMinimo);
  const statusUI = getStatusUI(statusKey);
  const agotado = statusKey === 'out';

  const card = document.createElement('article');
  card.className = 'card';

  card.innerHTML = `
    <div class="card-img-wrapper">
      <img src="${escapeHtml(product.imagen)}" alt="${escapeHtml(product.nombre)}" loading="lazy">
    </div>
    <div class="card-content">
      <span class="card-category">${escapeHtml(product.categoria)}</span>
      <button type="button" class="card-title" data-role="open-detail" aria-haspopup="dialog">${escapeHtml(product.nombre)}</button>
      <ul class="card-features">
        ${product.caracteristicas.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
      </ul>
      <div class="card-footer">
        <span class="card-price">${escapeHtml(formatPrice(product.precio, product.moneda))}</span>
        <span class="status-badge ${statusUI.class}">${escapeHtml(statusUI.text)}</span>
      </div>
      <button type="button" class="add-to-cart-btn" data-role="add-to-cart" ${agotado ? 'aria-disabled="true"' : ''}>
        ${agotado ? 'Agotado' : 'Agregar al carrito'}
      </button>
    </div>
  `;

  // Toda la tarjeta abre el detalle; el botón de agregar al carrito no lo abre.
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="add-to-cart"]')) return;
    openProductModal(product);
  });

  const addBtn = card.querySelector('[data-role="add-to-cart"]');
  if (!agotado) {
    addBtn.addEventListener('click', () => addToCart(product.id));
  }

  return card;
}

// Muestra el detalle de un producto en el modal
function openProductModal(product) {
  const statusKey = getAvailabilityStatus(product.existencias, product.stockMinimo);
  const statusUI = getStatusUI(statusKey);
  const agotado = statusKey === 'out';

  modalTitle.textContent = product.nombre;

  modalBody.innerHTML = `
    <img src="${escapeHtml(product.imagen)}" alt="${escapeHtml(product.nombre)}">
    <ul class="card-features">
      ${product.caracteristicas.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
    </ul>
    <div class="detail-row">
      <span class="detail-label">Categoría</span>
      <span>${escapeHtml(product.categoria)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Precio</span>
      <span class="card-price">${escapeHtml(formatPrice(product.precio, product.moneda))}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Estado</span>
      <span class="status-badge ${statusUI.class}">${escapeHtml(statusUI.text)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Existencias</span>
      <span>${product.existencias} unidades</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">ID de producto</span>
      <span style="font-family: monospace; color: var(--text-muted);">${escapeHtml(product.id)}</span>
    </div>
    <button type="button" class="add-to-cart-btn" id="modalAddToCartBtn" ${agotado ? 'disabled' : ''}>
      ${agotado ? 'Agotado' : 'Agregar al carrito'}
    </button>
    ${typeof window.openAssistant === 'function'
    ? '<button type="button" class="ask-assistant-btn" id="modalAskBtn">💬 Preguntar al asistente sobre este producto</button>'
    : ''}
  `;

  const askBtn = document.getElementById('modalAskBtn');
  if (askBtn) {
    askBtn.addEventListener('click', () => {
      closeModal(productModal);
      window.openAssistant(product.id);
    });
  }

  if (!agotado) {
    document.getElementById('modalAddToCartBtn').addEventListener('click', () => addToCart(product.id));
  }

  openModal(productModal);
  closeModalBtn.focus();
}

function openModal(modalEl) {
  modalEl.classList.add('active');
  modalEl.setAttribute('aria-hidden', 'false');
}

function closeModal(modalEl) {
  modalEl.classList.remove('active');
  modalEl.setAttribute('aria-hidden', 'true');
}

// ---- Carrito de demostración ----
// El carrito solo vive en memoria durante la sesión de la pestaña. No
// descuenta `existencias` del catálogo ni representa inventario real:
// GitHub Pages no puede persistir ni sincronizar esa información entre
// usuarios (ver README, sección "No es persistencia de inventario").

function findProductById(id) {
  return state.products.find((p) => p.id === id);
}

const MENSAJE_SIN_STOCK = 'No puedes pedir más productos de los disponibles';

function addToCart(id) {
  const product = findProductById(id);
  if (!product) return;

  const statusKey = getAvailabilityStatus(product.existencias, product.stockMinimo);
  if (statusKey === 'out') return;

  const item = state.cart.find((entry) => entry.id === id);
  const enCarrito = item ? item.cantidad : 0;

  // No se permite superar las existencias registradas del producto.
  if (enCarrito >= product.existencias) {
    showToast(MENSAJE_SIN_STOCK, `${product.nombre}: ${product.existencias} disponibles`, 'warning');
    return;
  }

  if (item) {
    item.cantidad += 1;
  } else {
    state.cart.push({ id, cantidad: 1 });
  }

  const cantidad = enCarrito + 1;
  showToast(`${product.nombre} agregado al carrito`, `Cantidad de este producto en el carrito: ${cantidad}`);
  updateCartUI();
}

function setCartQuantity(id, cantidad) {
  const item = state.cart.find((entry) => entry.id === id);
  const product = findProductById(id);
  if (!item || !product) return;

  if (cantidad <= 0) {
    removeFromCart(id);
    return;
  }

  if (cantidad > product.existencias) {
    showToast(MENSAJE_SIN_STOCK, `${product.nombre}: ${product.existencias} disponibles`, 'warning');
    return;
  }

  item.cantidad = cantidad;
  updateCartUI();
}

function removeFromCart(id) {
  state.cart = state.cart.filter((entry) => entry.id !== id);
  updateCartUI();
}

function getCartCount() {
  return state.cart.reduce((total, entry) => total + entry.cantidad, 0);
}

function getCartTotal() {
  return state.cart.reduce((total, entry) => {
    const product = findProductById(entry.id);
    return product ? total + product.precio * entry.cantidad : total;
  }, 0);
}

function updateCartUI() {
  cartCountEl.textContent = String(getCartCount());
  renderCart();
}

function renderCart() {
  if (state.cart.length === 0) {
    cartBody.innerHTML = '<p class="cart-empty">El carrito de demostración está vacío.</p>';
    return;
  }

  const moneda = state.products[0]?.moneda || 'COP';

  const itemsHtml = state.cart.map((entry) => {
    const product = findProductById(entry.id);
    if (!product) return '';

    return `
      <div class="cart-item" data-id="${escapeHtml(product.id)}">
        <img src="${escapeHtml(product.imagen)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:6px;">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(product.nombre)}</div>
          <div class="cart-item-price">${escapeHtml(formatPrice(product.precio, product.moneda))} c/u</div>
        </div>
        <div class="cart-item-qty">
          <button type="button" class="qty-btn" data-action="decrease" aria-label="Disminuir cantidad de ${escapeHtml(product.nombre)}">−</button>
          <span aria-live="polite">${entry.cantidad}</span>
          <button type="button" class="qty-btn" data-action="increase" aria-label="Aumentar cantidad de ${escapeHtml(product.nombre)}">+</button>
        </div>
        <button type="button" class="cart-item-remove" data-action="remove">Quitar</button>
      </div>
    `;
  }).join('');

  cartBody.innerHTML = `
    ${itemsHtml}
    <div class="cart-summary">
      <span>Total</span>
      <span>${escapeHtml(formatPrice(getCartTotal(), moneda))}</span>
    </div>
    <button type="button" class="checkout-btn" id="checkoutBtn">Finalizar pedido (demostración)</button>
    <p class="cart-disclaimer">
      Este carrito es solo una demostración de interfaz: no procesa pagos ni descuenta existencias reales.
    </p>
  `;

  cartBody.querySelectorAll('.cart-item').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-action="increase"]').addEventListener('click', () => {
      const entry = state.cart.find((e) => e.id === id);
      setCartQuantity(id, entry.cantidad + 1);
    });
    row.querySelector('[data-action="decrease"]').addEventListener('click', () => {
      const entry = state.cart.find((e) => e.id === id);
      setCartQuantity(id, entry.cantidad - 1);
    });
    row.querySelector('[data-action="remove"]').addEventListener('click', () => removeFromCart(id));
  });

  const checkoutBtn = document.getElementById('checkoutBtn');
  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', () => {
      announce('Pedido de demostración registrado. Ningún dato se envió ni se guardó.');
      window.alert('Este es un prototipo: el pedido no se envía ni se guarda en ningún sistema.');
    });
  }
}

function openCart() {
  renderCart();
  openModal(cartModal);
  closeCartBtn.focus();
}

// Muestra un error de carga/validación sin representar un catálogo parcial
function renderLoadError(error) {
  const detalles = Array.isArray(error.detalles) && error.detalles.length > 0
    ? `<ul>${error.detalles.slice(0, 8).map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
    : '';

  grid.innerHTML = `
    <div class="error-state">
      <h3>No se pudo cargar el catálogo</h3>
      <p>${escapeHtml(error.message || 'Ocurrió un error inesperado.')}</p>
      ${detalles}
    </div>
  `;
  resultsCount.textContent = 'Catálogo no disponible';
}

// ---- Eventos ----
searchInput.addEventListener('input', applyFilters);
categoryFilter.addEventListener('change', applyFilters);
statusFilter.addEventListener('change', applyFilters);
sortSelect.addEventListener('change', applyFilters);

closeModalBtn.addEventListener('click', () => closeModal(productModal));
productModal.addEventListener('click', (e) => {
  if (e.target === productModal) closeModal(productModal);
});

cartButton.addEventListener('click', openCart);
closeCartBtn.addEventListener('click', () => closeModal(cartModal));
cartModal.addEventListener('click', (e) => {
  if (e.target === cartModal) closeModal(cartModal);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (productModal.classList.contains('active')) closeModal(productModal);
  if (cartModal.classList.contains('active')) closeModal(cartModal);
});

// ---- Inicialización ----
async function init() {
  try {
    const data = await loadProducts();
    state.products = data;
    state.filteredProducts = data;

    initializeFilters(state.products);
    applyFilters();
  } catch (error) {
    console.error('Error al iniciar la aplicación:', error);
    renderLoadError(error);
  }
}

document.addEventListener('DOMContentLoaded', init);
