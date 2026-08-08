const formLogin = document.getElementById('form-login');
const btnLogin = document.getElementById('btn-login');
const msgError = document.getElementById('msg-error');

function mostrarError(texto) {
    msgError.textContent = texto;
    msgError.classList.remove('hidden');
}

// Si ya hay sesión activa, redirigir directo
(async () => {
    const perfil = await obtenerPerfilUsuario();
    if (perfil) {
        window.location.href = perfil.rol === 'admin' ? 'admin.html' : 'dashboard.html';
    }
})();

formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    msgError.classList.add('hidden');

    const usuario = document.getElementById('usuario').value.trim();
    const password = document.getElementById('password').value;

    btnLogin.disabled = true;
    btnLogin.textContent = 'Ingresando...';

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
        btnLogin.disabled = false;
        btnLogin.textContent = 'Ingresar';
    }
});