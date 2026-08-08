const formLogin = document.getElementById('form-login');
const btnLogin = document.getElementById('btn-login');
const msgError = document.getElementById('msg-error');
const msgErrorText = document.getElementById('msg-error-text');

// Funcionalidad Ver/Ocultar contraseña
const btnTogglePassword = document.getElementById('btn-toggle-password');
const inputPassword = document.getElementById('password');
const iconEye = document.getElementById('icon-eye');
const iconEyeOff = document.getElementById('icon-eye-off');

if (btnTogglePassword && inputPassword) {
    btnTogglePassword.addEventListener('click', () => {
        const esPassword = inputPassword.type === 'password';
        inputPassword.type = esPassword ? 'text' : 'password';
        iconEye.classList.toggle('hidden', esPassword);
        iconEyeOff.classList.toggle('hidden', !esPassword);
    });
}

function mostrarError(texto) {
    msgErrorText.textContent = texto;
    msgError.classList.remove('hidden');
}

function ocultarError() {
    msgError.classList.add('hidden');
    msgErrorText.textContent = '';
}

function setEstadoCargando(cargando) {
    btnLogin.disabled = cargando;
    if (cargando) {
        btnLogin.innerHTML = `
            <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-current inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Ingresando...</span>
        `;
        btnLogin.classList.add('opacity-80', 'cursor-not-allowed');
    } else {
        btnLogin.innerHTML = `<span>Ingresar</span>`;
        btnLogin.classList.remove('opacity-80', 'cursor-not-allowed');
    }
}

// Si ya hay sesión activa, redirigir directo
(async () => {
    try {
        if (typeof obtenerPerfilUsuario === 'function') {
            const perfil = await obtenerPerfilUsuario();
            if (perfil) {
                window.location.href = perfil.rol === 'admin' ? 'admin.html' : 'dashboard.html';
            }
        }
    } catch (e) {
        console.error('Error verificando sesión:', e);
    }
})();

formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    ocultarError();

    const usuario = document.getElementById('usuario').value.trim();
    const password = inputPassword.value;

    if (!usuario || !password) {
        mostrarError('Por favor, completá todos los campos.');
        return;
    }

    setEstadoCargando(true);

    try {
        // 1. Buscamos a qué email corresponde ese nombre de usuario
        const { data: email, error: errorEmail } = await supabase
            .rpc('get_email_by_usuario', { p_usuario: usuario });

        if (errorEmail || !email) {
            mostrarError('Usuario o contraseña incorrectos.');
            return;
        }

        // 2. Iniciamos sesión en Supabase Auth con ese email
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            mostrarError('Usuario o contraseña incorrectos.');
            return;
        }

        // 3. Redirigimos según el rol
        const { data: perfil } = await supabase
            .from('usuarios')
            .select('rol')
            .eq('id', data.user.id)
            .single();

        window.location.href = (perfil && perfil.rol === 'admin') ? 'admin.html' : 'dashboard.html';

    } catch (err) {
        console.error(err);
        mostrarError('Ocurrió un error. Intentá de nuevo.');
    } finally {
        setEstadoCargando(false);
    }
});
