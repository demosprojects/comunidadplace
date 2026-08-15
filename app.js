document.addEventListener('DOMContentLoaded', () => {
    
    // 1. LÓGICA DEL BOTÓN SCROLL TOP
    const scrollTopBtn = document.getElementById('scroll-top-btn');
    if (scrollTopBtn) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) {
                scrollTopBtn.classList.add('visible');
            } else {
                scrollTopBtn.classList.remove('visible');
            }
        });
        scrollTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // 2. CARRUSEL INFINITO Y FLUIDO (EMPRENDEDORES Y COMERCIOS)
    // Expuesta globalmente porque el contenido real se carga después, en tiempo
    // real desde Firestore (ver site-data.js), y puede volver a llamarse cada
    // vez que cambian los emprendedores/comercios (alta/baja/edición desde el admin).
    // Recibe el id del contenedor para poder reutilizarla en ambas secciones;
    // por compatibilidad, si no se pasa nada, usa "carousel-container" (emprendedores).
    const carruselAnimationIds = {};
    window.iniciarCarruselInfinito = function iniciarCarruselInfinito(containerId = 'carousel-container') {
        const container = document.getElementById(containerId);
        if (!container || !container.children.length) return;

        // Si ya había un loop de scroll corriendo (de una carga anterior),
        // lo cancelamos para no acumular loops duplicados.
        if (carruselAnimationIds[containerId]) {
            cancelAnimationFrame(carruselAnimationIds[containerId]);
            carruselAnimationIds[containerId] = null;
        }
        container.scrollLeft = 0;

        // Con pocos elementos, todos entran en pantalla sin necesidad de
        // scroll: si duplicáramos igual, se verían literalmente repetidos.
        // Solo duplicamos (y animamos) cuando el contenido real desborda el
        // contenedor y hace falta el efecto de loop infinito.
        const necesitaLoop = container.scrollWidth > container.clientWidth;

        if (!necesitaLoop) {
            container.classList.add('justify-center');
            return;
        }
        container.classList.remove('justify-center');

        container.innerHTML = container.innerHTML + container.innerHTML;
        let scrollPos = 0;
        const speed = 0.5;

        function autoScroll() {
            scrollPos += speed;
            if (scrollPos >= container.scrollWidth / 2) {
                scrollPos = 0;
            }
            container.scrollLeft = scrollPos;
            carruselAnimationIds[containerId] = requestAnimationFrame(autoScroll);
        }
        carruselAnimationIds[containerId] = requestAnimationFrame(autoScroll);
    };

    // 3. LÓGICA DE PREGUNTAS FRECUENTES (FAQ ACCORDION)
    // El alto de la respuesta se calcula en JS (answer.scrollHeight) en vez de
    // usar un max-height fijo en el CSS: así la animación siempre dura lo mismo
    // sin importar si la respuesta es corta o larga, y no se siente "lenta".
    document.querySelectorAll('.faq-item').forEach(item => {
        const btn = item.querySelector('.faq-btn');
        const answer = item.querySelector('.faq-answer');
        if (!btn || !answer) return;

        // Arrancamos siempre cerrado con un valor explícito en píxeles (no "none"),
        // para que la transición funcione tanto al abrir como al cerrar.
        answer.style.maxHeight = '0px';

        btn.addEventListener('click', () => {
            const abriendo = !item.classList.contains('active');
            item.classList.toggle('active', abriendo);
            answer.style.maxHeight = abriendo ? answer.scrollHeight + 'px' : '0px';
        });
    });

    // 4. FUNCIONAMIENTO DE LOS BOTONES DEL BANNER (HERO)
    const btnParticipar = document.getElementById('btn-participar');
    const btnFeria = document.getElementById('btn-feria');

    if (btnParticipar) {
        btnParticipar.onclick = () => {
            document.getElementById('contacto').scrollIntoView({ behavior: 'smooth' });
        };
    }

    if (btnFeria) {
        btnFeria.onclick = () => {
            document.getElementById('seccion-feria').scrollIntoView({ behavior: 'smooth' });
        };
    }

    // 5. EFECTO DE REVELACIÓN AL HACER SCROLL
    const revealOnScroll = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = "1";
                entry.target.style.transform = "translateY(0)";
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('section').forEach(section => {
        section.style.opacity = "0";
        section.style.transform = "translateY(20px)";
        section.style.transition = "all 0.6s ease-out";
        revealOnScroll.observe(section);
    });

    // 6. LÓGICA DEL CARRUSEL DE GALERÍA DE FOTOS
    const galleryContainer = document.getElementById('gallery-container');
    const galleryNext = document.getElementById('gallery-next');
    const galleryPrev = document.getElementById('gallery-prev');

    if (galleryContainer && galleryNext && galleryPrev) {
        galleryNext.addEventListener('click', () => {
            galleryContainer.scrollBy({ left: galleryContainer.offsetWidth * 0.8, behavior: 'smooth' });
        });
        galleryPrev.addEventListener('click', () => {
            galleryContainer.scrollBy({ left: -galleryContainer.offsetWidth * 0.8, behavior: 'smooth' });
        });
    }
});

// 7. FUNCIONES GLOBALES PARA EL MODAL DEL MAPA
function abrirMapa(urlEmbed) {
    const modal = document.getElementById('modal-mapa');
    const iframe = document.getElementById('iframe-mapa');
    const loader = document.getElementById('map-loader');
    const linkExterno = document.getElementById('link-google-maps');

    if (modal && iframe) {
        iframe.classList.add('opacity-0');
        if (loader) loader.classList.remove('hidden');
        
        iframe.src = urlEmbed;
        if (linkExterno) linkExterno.href = urlEmbed.replace('embed?', 'view?'); 
        
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';
    }
}

function quitarLoader() {
    const loader = document.getElementById('map-loader');
    const iframe = document.getElementById('iframe-mapa');
    if (loader) loader.classList.add('hidden');
    if (iframe) iframe.classList.remove('opacity-0');
}

function cerrarMapa() {
    const modal = document.getElementById('modal-mapa');
    const iframe = document.getElementById('iframe-mapa');
    if (modal && iframe) {
        iframe.src = "";
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        document.body.style.overflow = 'auto';
    }
}

window.onclick = function(event) {
    const modal = document.getElementById('modal-mapa');
    if (event.target == modal) {
        cerrarMapa();
    }
}

// 8. LÓGICA PARA EL MODAL DE FOTOS CON NAVEGACIÓN
let imagenesGaleria = [];
let indiceActual = 0;

// Detecta todas las fotos disponibles en la galería. Se llama al cargar el DOM
// y de nuevo desde site-data.js cada vez que se renderizan fotos desde Firestore.
window.actualizarImagenesGaleria = function actualizarImagenesGaleria() {
    const imagenesHTML = document.querySelectorAll('#gallery-container img');
    imagenesGaleria = Array.from(imagenesHTML).map(img => img.getAttribute('src'));
};

document.addEventListener('DOMContentLoaded', () => {
    window.actualizarImagenesGaleria();
});

// Ajuste en la función abrirFoto para manejar imágenes fuera de la galería
function abrirFoto(src) {
    const modal = document.getElementById('modal-foto');
    const img = document.getElementById('img-ampliada');
    
    if (modal && img) {
        // Buscamos si la imagen está en la galería para habilitar flechas
        const index = imagenesGaleria.indexOf(src);
        indiceActual = index !== -1 ? index : 0; 
        
        img.src = src;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';

        // Opcional: Ocultar flechas si la imagen no es parte de la galería
        const flechas = modal.querySelectorAll('button[onclick^="cambiarFoto"]');
        flechas.forEach(f => f.style.display = index === -1 ? 'none' : 'block');
    }
}
function cambiarFoto(direccion) {
    const img = document.getElementById('img-ampliada');
    const caption = document.getElementById('caption-foto'); // Seleccionamos el texto
    
    indiceActual += direccion;
    
    if (indiceActual < 0) {
        indiceActual = imagenesGaleria.length - 1;
    } else if (indiceActual >= imagenesGaleria.length) {
        indiceActual = 0;
    }
    
    // Efecto de transición para imagen y texto
    img.style.opacity = '0';
    caption.style.opacity = '0';
    caption.style.transform = 'translateY(10px)';

    setTimeout(() => {
        img.src = imagenesGaleria[indiceActual];
        img.style.opacity = '1';
        
        // El texto aparece con un leve movimiento hacia arriba
        caption.style.opacity = '1';
        caption.style.transform = 'translateY(0)';
        caption.style.transition = 'all 0.4s ease';
    }, 150);
}

function cerrarFoto() {
    const modal = document.getElementById('modal-foto');
    const img = document.getElementById('img-ampliada');
    
    if (modal && img) {
        img.classList.remove('scale-100');
        img.classList.add('scale-95');
        
        setTimeout(() => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = 'auto';
            img.src = "";
        }, 200);
    }
}

// Control por teclado (Esc, Flechas Izquierda y Derecha)
window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('modal-foto');
    if (modal && !modal.classList.contains('hidden')) {
        if (e.key === "Escape") cerrarFoto();
        if (e.key === "ArrowRight") cambiarFoto(1);
        if (e.key === "ArrowLeft") cambiarFoto(-1);
    }
});

// 9. SKELETONS DE CARGA (mientras llegan los datos de Firestore)
// No dependen de que site-data.js las llame explícitamente: se limpian solas
// apenas detectan contenido real, así que funcionan aunque cambie la forma
// en la que site-data.js arma el HTML.
document.addEventListener('DOMContentLoaded', () => {

    // Tiempo máximo que dejamos un skeleton visible aunque no haya llegado
    // contenido real (por ejemplo, si Firestore tarda o falla). Evita que
    // quede "cargando" para siempre.
    const SKELETON_TIMEOUT_MS = 15000;

    // 9.1 Contenedores donde el contenido real se agrega como hijos nuevos
    // (galería, emprendedores, testimonios): apenas aparece un hijo que no es
    // un skeleton, quitamos los placeholders.
    function observarSkeletonPorHijos(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const quitarSkeletons = () => {
            container.querySelectorAll('[data-skeleton]').forEach(el => el.remove());
        };

        const hayContenidoReal = () =>
            Array.from(container.children).some(el => !el.hasAttribute('data-skeleton'));

        if (hayContenidoReal()) {
            quitarSkeletons();
            return;
        }

        const observer = new MutationObserver(() => {
            if (hayContenidoReal()) {
                quitarSkeletons();
                observer.disconnect();
            }
        });
        observer.observe(container, { childList: true });

        setTimeout(() => {
            quitarSkeletons();
            observer.disconnect();
        }, SKELETON_TIMEOUT_MS);
    }

    // 9.2 "ferias-container" ahora puede recibir una o varias tarjetas de
    // feria (antes era una sola tarjeta fija), así que usa el mismo
    // mecanismo por-hijos que galería/comercios/emprendedores.
    ['gallery-container', 'carousel-container', 'comercios-container', 'testimonios-container', 'ferias-container'].forEach(observarSkeletonPorHijos);
});