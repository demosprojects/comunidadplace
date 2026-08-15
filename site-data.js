/* =========================================================
   SITE-DATA.JS
   Escucha en TIEMPO REAL (onSnapshot) los cambios en Firestore
   que se hacen desde el panel admin (admin.html) y actualiza
   la web pública (index.html) sin necesidad de recargar.
   No modifica el comportamiento de app.js, solo llena el DOM
   con datos y después dispara las funciones de app.js que
   necesitan que el contenido ya esté en la página
   (actualizarImagenesGaleria, iniciarCarruselInfinito).
   ========================================================= */

function escaparHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto ?? "";
    return div.innerHTML;
}

/* ---------- 1. PRÓXIMOS EVENTOS (una o varias ferias activas) ---------- */
// Antes se mostraba una sola feria "activa" a la vez. Ahora se pueden marcar
// varias como activas (por ejemplo la de este domingo y la siguiente) y acá
// se pintan todas, apiladas, con el mismo diseño. La primera se etiqueta
// "Próxima Edición" y el resto "Siguiente Feria". Se ordenan por fecha de
// creación para que, al ir borrando la que ya pasó, la que sigue pase
// automáticamente a ocupar el primer lugar.
function escucharFeriaActiva() {
    const container = document.getElementById('ferias-container');
    const sinEventos = document.getElementById('feria-sin-eventos');
    if (!container) return;

    db.collection('ferias')
        .where('activa', '==', true)
        .onSnapshot(snap => {
            if (snap.empty) {
                container.innerHTML = '';
                if (sinEventos) sinEventos.classList.remove('hidden');
                return;
            }

            if (sinEventos) sinEventos.classList.add('hidden');

            // Ordenamos acá (en vez de con .orderBy en la consulta) para no
            // necesitar crear un índice compuesto en Firestore para
            // "activa + createdAt". Los timestamps de Firestore tienen
            // .toMillis(); si por algo faltara, los mandamos al final.
            const docsOrdenados = [...snap.docs].sort((a, b) => {
                const ca = a.data().createdAt;
                const cb = b.data().createdAt;
                const ma = ca && ca.toMillis ? ca.toMillis() : 0;
                const mb = cb && cb.toMillis ? cb.toMillis() : 0;
                return ma - mb;
            });

            container.innerHTML = docsOrdenados.map((doc, i) => {
                const feria = doc.data();
                const flyerUrl = escaparHtml(feria.flyerUrl || '');
                const tituloEscapado = escaparHtml(feria.titulo || '');
                const etiqueta = i === 0 ? 'Próxima Edición' : 'Siguiente Feria';

                return `
                <div class="bg-white rounded-[2.5rem] shadow-2xl shadow-slate-200/50 overflow-hidden border border-slate-100 flex flex-col md:flex-row transition-all hover:shadow-yellow-200/20">

                    <div class="relative w-full md:w-2/5 h-64 md:h-auto overflow-hidden">
                        <div onclick="abrirFoto('${flyerUrl}')" class="relative group cursor-pointer w-full h-full">
                            <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center gap-2 z-20">
                                <i class="fas fa-search-plus text-white text-3xl"></i>
                                <span class="text-white text-[10px] font-black uppercase tracking-widest">Ver flyer completo</span>
                            </div>
                            <img src="${flyerUrl}" class="w-full h-full object-cover" alt="Flyer de ${tituloEscapado}">
                        </div>

                        <div class="absolute top-6 left-6 bg-white rounded-2xl shadow-xl p-3 text-center min-w-[70px] z-10">
                            <p class="text-xs font-black uppercase text-slate-400 leading-none mb-1">${escaparHtml(feria.mes)}</p>
                            <p class="text-3xl font-black text-black leading-none">${escaparHtml(feria.diaNumero)}</p>
                        </div>

                        <div class="absolute bottom-4 left-4 z-10">
                            <span class="bg-yellow-comunidad text-black text-[10px] font-black uppercase px-3 py-1 rounded-full shadow-lg">
                                ${etiqueta}
                            </span>
                        </div>
                    </div>

                    <div class="w-full md:w-3/5 p-8 md:p-12 flex flex-col justify-center">
                        <div class="flex items-center gap-2 mb-4">
                            <div class="h-1 w-10 bg-yellow-comunidad rounded-full"></div>
                            <span class="text-yellow-600 font-bold text-xs uppercase tracking-tighter">${escaparHtml(feria.diaSemana)}</span>
                        </div>

                        <h3 class="text-3xl md:text-4xl font-black text-slate-900 mb-6 leading-tight">${tituloEscapado}</h3>

                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-xl bg-yellow-50 flex items-center justify-center flex-shrink-0">
                                    <i class="fas fa-clock text-yellow-600"></i>
                                </div>
                                <div>
                                    <p class="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Horario</p>
                                    <p class="text-slate-700 font-bold">${escaparHtml(feria.horario)}</p>
                                </div>
                            </div>
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-xl bg-yellow-50 flex items-center justify-center flex-shrink-0">
                                    <i class="fas fa-map-marker-alt text-yellow-600"></i>
                                </div>
                                <div>
                                    <p class="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Ubicación</p>
                                    <p class="text-slate-700 font-bold">${escaparHtml(feria.ubicacion)}</p>
                                </div>
                            </div>
                        </div>

                        <div class="flex flex-col sm:flex-row gap-4">
                            ${feria.mapaEmbedUrl ? `
                            <button onclick="abrirMapa('${escaparHtml(feria.mapaEmbedUrl)}')"
                                    class="flex-1 bg-black text-white py-4 rounded-2xl font-black text-sm hover:bg-slate-800 transition shadow-xl shadow-black/10 flex items-center justify-center gap-2">
                                <i class="fas fa-location-dot"></i> Ver ubicación
                            </button>` : ''}
                            <a href="#contacto" class="flex-1 bg-yellow-comunidad text-black py-4 rounded-2xl font-black text-sm hover:bg-yellow-500 transition shadow-xl shadow-yellow-200 flex items-center justify-center gap-2 uppercase">
                                Quiero participar
                            </a>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }, err => {
            console.error('Error al escuchar las ferias activas:', err);
            if (sinEventos) sinEventos.classList.remove('hidden');
        });
}

/* ---------- 2. GALERÍA DE FOTOS ---------- */
function escucharGaleria() {
    const container = document.getElementById('gallery-container');
    const vacio = document.getElementById('gallery-empty');
    if (!container) return;

    db.collection('galeria').orderBy('orden', 'asc').onSnapshot(snap => {
        if (snap.empty) {
            container.innerHTML = '';
            vacio.classList.remove('hidden');
            return;
        }

        vacio.classList.add('hidden');
        container.innerHTML = snap.docs.map(doc => {
            const foto = doc.data();
            const url = escaparHtml(foto.url);
            return `
                <div class="flex-none w-[80%] sm:w-[45%] lg:w-[30%] snap-center">
                    <div onclick="abrirFoto('${url}')" class="relative group cursor-pointer overflow-hidden rounded-[1.5rem] md:rounded-[2rem] shadow-md">
                        <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center gap-2 z-10">
                            <i class="fas fa-search-plus text-white text-2xl"></i>
                            <span class="text-white text-[10px] font-black uppercase tracking-widest">Ver foto</span>
                        </div>
                        <img src="${url}" class="w-full h-[300px] md:h-[400px] object-cover transform group-hover:scale-105 transition duration-500" alt="${escaparHtml(foto.alt || 'Foto de la feria')}">
                    </div>
                </div>`;
        }).join('');

        window.actualizarImagenesGaleria();
    }, err => {
        console.error('Error al escuchar la galería:', err);
    });
}

/* ---------- 3. EMPRENDEDORES PARTICIPANTES + TESTIMONIOS ---------- */
function escucharEmprendedores() {
    const container = document.getElementById('carousel-container');
    const testimoniosContainer = document.getElementById('testimonios-container');
    const testimoniosVacio = document.getElementById('testimonios-empty');
    if (!container) return;

    db.collection('emprendedores').orderBy('orden', 'asc').onSnapshot(snap => {
        if (snap.empty) {
            container.innerHTML = '';
            if (testimoniosContainer) testimoniosContainer.innerHTML = '';
            if (testimoniosVacio) testimoniosVacio.classList.remove('hidden');
            return;
        }

        // Importante: acá se pinta el set "original" (sin duplicar). La
        // duplicación para el efecto de scroll infinito la hace
        // iniciarCarruselInfinito() en app.js.
        container.innerHTML = snap.docs.map(doc => {
            const e = doc.data();
            return `
                <div class="flex-none w-36 md:w-40">
                    <div class="w-28 h-28 md:w-32 md:h-32 mx-auto rounded-full border-4 border-yellow-comunidad p-1 mb-4 shadow-md">
                        <img src="${escaparHtml(e.logoUrl)}" class="w-full h-full object-cover rounded-full bg-slate-100" alt="${escaparHtml(e.nombre)}">
                    </div>
                    <p class="font-bold text-base md:text-lg">${escaparHtml(e.nombre)}</p>
                    <span class="text-xs uppercase tracking-widest text-slate-400">${escaparHtml(e.categoria || '')}</span>
                </div>`;
        }).join('');

        window.iniciarCarruselInfinito();

        // "Lo que dicen nuestros emprendedores": solo los que cargaron un testimonio
        if (testimoniosContainer) {
            const conTestimonio = snap.docs.filter(doc => (doc.data().testimonio || '').trim().length > 0);

            if (!conTestimonio.length) {
                testimoniosContainer.innerHTML = '';
                if (testimoniosVacio) testimoniosVacio.classList.remove('hidden');
            } else {
                if (testimoniosVacio) testimoniosVacio.classList.add('hidden');
                testimoniosContainer.innerHTML = conTestimonio.map(doc => {
                    const e = doc.data();
                    return `
                        <div class="bg-slate-50 p-8 rounded-[2rem] shadow-sm relative italic text-slate-600">
                            <i class="fas fa-quote-left text-yellow-400 text-3xl absolute top-6 left-6 opacity-30"></i>
                            <p class="relative z-10 mb-6 mt-4">"${escaparHtml(e.testimonio)}"</p>
                            <div class="flex items-center justify-center gap-3 not-italic">
                                <img src="${escaparHtml(e.logoUrl)}" class="w-10 h-10 rounded-full object-cover border-2 border-yellow-comunidad" alt="${escaparHtml(e.nombre)}">
                                <div class="text-left leading-tight">
                                    <p class="font-bold text-black text-sm">${escaparHtml(e.nombre)}</p>
                                    <p class="text-xs text-slate-400">${escaparHtml(e.categoria || '')}</p>
                                </div>
                            </div>
                        </div>`;
                }).join('');
            }
        }
    }, err => {
        console.error('Error al escuchar emprendedores:', err);
    });
}

/* ---------- 4. COMERCIOS ADHERIDOS ---------- */
// Igual que escucharEmprendedores(), pero sin testimonio: los comercios
// están adheridos y no participan directamente de la feria, así que no
// se muestran en "Lo que dicen nuestros emprendedores".
function escucharComercios() {
    const container = document.getElementById('comercios-container');
    if (!container) return;

    db.collection('comercios').orderBy('orden', 'asc').onSnapshot(snap => {
        if (snap.empty) {
            container.innerHTML = '';
            return;
        }

        // Importante: acá se pinta el set "original" (sin duplicar). La
        // duplicación para el efecto de scroll infinito la hace
        // iniciarCarruselInfinito() en app.js.
        container.innerHTML = snap.docs.map(doc => {
            const c = doc.data();
            return `
                <div class="flex-none w-36 md:w-40">
                    <div class="w-28 h-28 md:w-32 md:h-32 mx-auto rounded-full border-4 border-slate-800 p-1 mb-4 shadow-md">
                        <img src="${escaparHtml(c.logoUrl)}" class="w-full h-full object-cover rounded-full bg-slate-100" alt="${escaparHtml(c.nombre)}">
                    </div>
                    <p class="font-bold text-base md:text-lg">${escaparHtml(c.nombre)}</p>
                    <span class="text-xs uppercase tracking-widest text-slate-400">${escaparHtml(c.categoria || '')}</span>
                </div>`;
        }).join('');

        window.iniciarCarruselInfinito('comercios-container');
    }, err => {
        console.error('Error al escuchar comercios:', err);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    escucharFeriaActiva();
    escucharGaleria();
    escucharEmprendedores();
    escucharComercios();
});