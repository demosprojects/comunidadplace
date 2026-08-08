let perfilAdmin = null;

document.addEventListener('DOMContentLoaded', async () => {
    perfilAdmin = await requerirSesion('admin');
    if (!perfilAdmin) return;

    await cargarEmprendedores();
    iniciarRealtimeAdmin();
});

// ============================================================
// TIEMPO REAL: si un emprendedor sube un producto, se registra,
// o se toca algo desde otra pestaña, las 3 tablas del admin se
// actualizan solas (sin recargar la página)
// ============================================================
function iniciarRealtimeAdmin() {
    suscribirTabla('emprendedores', debounce(cargarEmprendedores, 350));
    suscribirTabla('categorias', debounce(cargarCategoriasAdmin, 350));
    suscribirTabla('productos', debounce(cargarProductosAdmin, 350));
}

// ============================================================
// NAVEGACIÓN
// ============================================================
const NAV_BASE = "w-full text-left px-4 py-2.5 rounded-xl transition-all flex items-center justify-between group";
const NAV_ACTIVO = `${NAV_BASE} bg-yellow-400 text-black font-bold shadow-md shadow-yellow-400/10`;
const NAV_INACTIVO = `${NAV_BASE} text-gray-400 hover:text-white`;

function mostrarSeccion(id) {
    const secciones = ['emprendedores', 'categorias', 'productos'];
    secciones.forEach(s => {
        document.getElementById('section-' + s).classList.toggle('hidden', s !== id);
        document.getElementById('nav-' + s).className = s === id ? NAV_ACTIVO : NAV_INACTIVO;
    });
    if (id === 'categorias') cargarCategoriasAdmin();
    if (id === 'productos') cargarProductosAdmin();
}

// ============================================================
// EMPRENDEDORES
// ============================================================
async function cargarEmprendedores() {
    const grid = document.getElementById('grid-emprendedores');
    const contador = document.getElementById('contador-emprendedores');
    const { data, error } = await supabase
        .from('emprendedores')
        .select('*, usuarios(usuario, email)')
        .order('created_at', { ascending: false });

    if (error) {
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center gap-2 py-24 text-red-400 font-semibold">
                <span>Error cargando emprendedores.</span>
            </div>`;
        contador.textContent = '';
        console.error(error);
        return;
    }

    if (data.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center gap-3 py-24 text-center">
                <div class="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center text-2xl">🏬</div>
                <p class="text-slate-500 font-bold">Todavía no hay emprendedores registrados.</p>
                <p class="text-slate-400 text-sm">Van a aparecer acá apenas alguien se registre en la comunidad.</p>
            </div>`;
        contador.textContent = '';
        return;
    }

    contador.textContent = `${data.length} emprendedor${data.length === 1 ? '' : 'es'} · ${data.filter(e => e.activo).length} activo${data.filter(e => e.activo).length === 1 ? '' : 's'}`;

    grid.innerHTML = data.map(e => {
        const inicial = e.nombre_tienda ? e.nombre_tienda.charAt(0).toUpperCase() : '?';
        const avatar = e.logo_url
            ? `<img src="${e.logo_url}" alt="${escapeHtml(e.nombre_tienda)}" class="w-full h-full object-cover">`
            : `<div class="w-full h-full flex items-center justify-center bg-gradient-to-tr from-yellow-400 to-amber-300 text-black font-black text-4xl">${escapeHtml(inicial)}</div>`;
        return `
        <div class="group bg-white rounded-3xl border border-slate-200/80 shadow-sm hover:shadow-xl hover:shadow-slate-900/5 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden flex flex-col">
            <div class="relative aspect-square bg-slate-100 overflow-hidden">
                ${avatar}
                <span class="absolute top-3 left-3 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full backdrop-blur-md ${e.activo ? 'bg-emerald-500/90 text-white' : 'bg-red-500/90 text-white'}">
                    ${e.activo ? 'Activo' : 'Bloqueado'}
                </span>
            </div>
            <div class="p-4 flex flex-col gap-1.5 flex-1">
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">@${e.usuarios ? escapeHtml(e.usuarios.usuario) : '-'}</span>
                <h3 class="font-extrabold text-slate-900 leading-snug line-clamp-1">${escapeHtml(e.nombre_tienda)}</h3>
                <p class="text-xs text-slate-500 font-medium truncate">${e.whatsapp ? escapeHtml(e.whatsapp) : 'Sin WhatsApp cargado'}</p>
                <div class="mt-auto pt-2">
                    <button onclick="toggleEmprendedor('${e.id}', ${e.activo})"
                        class="w-full py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-colors ${e.activo ? 'bg-red-50 text-red-500 hover:bg-red-500 hover:text-white' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white'}">
                        ${e.activo ? 'Bloquear' : 'Activar'}
                    </button>
                </div>
            </div>
        </div>
    `;
    }).join('');
}

async function toggleEmprendedor(id, activoActual) {
    const { error } = await supabase.from('emprendedores').update({ activo: !activoActual }).eq('id', id);
    if (error) { mostrarToast('No se pudo actualizar el estado.', 'error'); console.error(error); return; }
    mostrarToast(activoActual ? 'Emprendedor bloqueado.' : 'Emprendedor activado.', 'success');
    await cargarEmprendedores();
}

// ============================================================
// CATEGORIAS
// ============================================================
async function cargarCategoriasAdmin() {
    const tabla = document.getElementById('tabla-categorias');
    const { data, error } = await supabase.from('categorias').select('*').order('nombre');
    if (error) {
        tabla.innerHTML = `<div class="col-span-full p-8 text-center text-red-400 font-semibold">Error cargando categorías.</div>`;
        return;
    }

    if (data.length === 0) {
        tabla.innerHTML = `<div class="col-span-full p-8 text-center text-slate-400 font-semibold">No hay categorías todavía.</div>`;
        return;
    }

    tabla.innerHTML = data.map(c => `
        <div class="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-center justify-between gap-3 hover:shadow-md transition-shadow">
            <div class="min-w-0">
                <p class="font-extrabold text-slate-900 truncate">${escapeHtml(c.nombre)}</p>
                <p class="text-xs text-slate-400 truncate">${escapeHtml(c.slug)}</p>
            </div>
            <div class="flex items-center gap-3 shrink-0">
                <button onclick="editarCategoria(${c.id})" class="text-slate-400 hover:text-slate-700 font-black text-[10px] uppercase tracking-widest transition-colors">Editar</button>
                <button onclick="eliminarCategoria(${c.id})" class="text-red-400 hover:text-red-600 font-black text-[10px] uppercase tracking-widest transition-colors">Eliminar</button>
            </div>
        </div>
    `).join('');
}

// "categoria" es opcional: si se pasa, el modal entra en modo edición
// precargado con esos datos; si no, abre en modo creación.
function abrirModalCategoria(categoria = null) {
    const form = document.getElementById('form-categoria');
    form.reset();

    document.getElementById('cat-id').value = categoria ? categoria.id : '';
    document.getElementById('modal-categoria-titulo').textContent = categoria ? 'Editar categoría' : 'Nueva categoría';
    document.getElementById('modal-categoria-subtitulo').textContent = categoria
        ? 'Modificá el nombre de la categoría'
        : 'Ingresá el nombre que aparecerá en la tienda';
    document.getElementById('btn-guardar-categoria').textContent = categoria ? 'Guardar cambios' : 'Guardar';

    if (categoria) document.getElementById('cat-nombre').value = categoria.nombre;

    document.getElementById('modal-categoria').classList.remove('hidden');
    document.getElementById('cat-nombre').focus();
}
function cerrarModalCategoria() {
    document.getElementById('modal-categoria').classList.add('hidden');
}

async function editarCategoria(id) {
    const { data, error } = await supabase.from('categorias').select('*').eq('id', id).single();
    if (error || !data) { mostrarToast('No se pudo cargar la categoría.', 'error'); return; }
    abrirModalCategoria(data);
}

document.getElementById('form-categoria').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('cat-id').value;
    const nombre = document.getElementById('cat-nombre').value.trim();
    const slug = nombre.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes
        .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const btnGuardar = document.getElementById('btn-guardar-categoria');
    btnGuardar.disabled = true;

    const { error } = id
        ? await supabase.from('categorias').update({ nombre, slug }).eq('id', id)
        : await supabase.from('categorias').insert({ nombre, slug });

    btnGuardar.disabled = false;

    if (error) {
        mostrarToast(error.message.includes('duplicate') ? 'Esa categoría ya existe.' : 'No se pudo guardar la categoría.', 'error');
        return;
    }

    mostrarToast(id ? 'Categoría actualizada.' : 'Categoría creada.', 'success');
    cerrarModalCategoria();
    await cargarCategoriasAdmin();
});

async function eliminarCategoria(id) {
    const confirmado = await confirmarAccion(
        'Los productos que la usan quedarán sin categoría.',
        { titulo: '¿Eliminar esta categoría?', textoConfirmar: 'Eliminar' }
    );
    if (!confirmado) return;

    const { error } = await supabase.from('categorias').delete().eq('id', id);
    if (error) { mostrarToast('No se pudo eliminar la categoría.', 'error'); return; }
    mostrarToast('Categoría eliminada.', 'success');
    await cargarCategoriasAdmin();
}

// ============================================================
// PRODUCTOS (vista global)
// ============================================================
async function cargarProductosAdmin() {
    const tabla = document.getElementById('tabla-productos-admin');
    const { data, error } = await supabase
        .from('productos')
        .select('*, emprendedores(nombre_tienda)')
        .order('created_at', { ascending: false });

    if (error) { tabla.innerHTML = `<div class="p-8 text-center text-red-400 font-semibold">Error cargando productos.</div>`; return; }

    if (data.length === 0) {
        tabla.innerHTML = `<div class="p-8 text-center text-slate-400 font-semibold">No hay productos cargados todavía.</div>`;
        return;
    }

    tabla.innerHTML = data.map(p => `
        <div class="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 hover:shadow-md transition-shadow">
            <div class="flex items-center gap-3 min-w-0 flex-1">
                <img src="${p.imagen_url || ''}" class="w-12 h-12 rounded-xl object-cover border border-slate-100 bg-slate-100 flex-shrink-0">
                <div class="min-w-0">
                    <p class="font-extrabold text-slate-900 truncate">${escapeHtml(p.nombre)}</p>
                    <p class="text-xs text-slate-400 truncate">${p.emprendedores ? escapeHtml(p.emprendedores.nombre_tienda) : '-'}</p>
                </div>
            </div>
            <div class="flex items-center justify-between sm:justify-end gap-4 sm:gap-6 flex-shrink-0 pl-[60px] sm:pl-0">
                <span class="font-black text-slate-900 whitespace-nowrap">${formatoPrecio(p.precio)}</span>
                <span class="text-[10px] font-black uppercase px-2 py-1 rounded-full whitespace-nowrap ${p.activo ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}">
                    ${p.activo ? 'Visible' : 'Oculto'}
                </span>
                <button onclick="eliminarProductoAdmin('${p.id}')" class="text-red-400 hover:text-red-600 font-black text-[10px] uppercase tracking-widest transition-colors whitespace-nowrap">Eliminar</button>
            </div>
        </div>
    `).join('');
}

async function eliminarProductoAdmin(id) {
    const confirmado = await confirmarAccion(
        'Esta acción no se puede deshacer.',
        { titulo: '¿Eliminar este producto de la plataforma?', textoConfirmar: 'Eliminar' }
    );
    if (!confirmado) return;

    const { error } = await supabase.from('productos').delete().eq('id', id);
    if (error) { mostrarToast('No se pudo eliminar el producto.', 'error'); return; }
    mostrarToast('Producto eliminado.', 'success');
    await cargarProductosAdmin();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
