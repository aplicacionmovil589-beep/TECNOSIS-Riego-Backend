require('dotenv').config(); 
// 1. Requerir librerías
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors'); 
const path = require('path'); 

const app = express();
app.use(bodyParser.json());
app.use(cors()); // Habilitar CORS para comunicación entre frontend/backend

// 2. Definir variables de Entorno
const ACCESS_ID = process.env.TUYA_ACCESS_ID ? process.env.TUYA_ACCESS_ID.trim() : null;
const SECRET_KEY = process.env.TUYA_SECRET_KEY ? process.env.TUYA_SECRET_KEY.trim() : null;
const DEVICE_ID_VALVE = process.env.TUYA_DEVICE_ID_VALVE;
const PORT = 3000;
const BASE_URL = process.env.TUYA_ENDPOINT; 

// ----------------------------------------------------
// VARIABLES GLOBALES PARA RIEGO AUTOMÁTICO Y SEGURIDAD
// ----------------------------------------------------
let lastKnownHumidity = 0;
const HUMIDITY_THRESHOLD = 45; 
const HUMIDITY_MARGIN = 5; 
let autoCloseTimer = null; 

// VARIABLES DE SEGURIDAD ESTÁTICAS (Para el Login)
const STATIC_USERNAME = 'admin';
const STATIC_PASSWORD = '123'; // ¡Cambia esta contraseña para el uso real!
const SESSION_TOKEN_SECRET = 'TU_SECRETO_SEGURO_AQUI_2025'; // Usado para firmar el token

// ******* VERIFICACIÓN CRÍTICA *******
if (!ACCESS_ID || !SECRET_KEY || !BASE_URL) {
    // Si falta la clave, el servidor se cerrará inmediatamente para evitar fallos de Tuya.
    console.error("❌ ERROR CRÍTICO: Variables de entorno faltantes. Revisa el archivo .env.");
    return;
}

// ----------------------------------------------------
// 3. FUNCIÓN PARA OBTENER EL TOKEN DE ACCESO (Tuya Grant Token)
// ----------------------------------------------------
async function getAccessToken() {
    const t = Date.now().toString(); 
    const method = 'GET';
    const path = '/v1.0/token';
    const query = '?grant_type=1';
    const bodyHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');

    const stringToSign = [ method, bodyHash, '', path + query ].join('\n');
    const str = ACCESS_ID + t + stringToSign; 

    const sign = crypto
        .createHmac("sha256", Buffer.from(SECRET_KEY, 'utf8'))
        .update(str, "utf8")
        .digest("hex")
        .toUpperCase();

    const headers = {
        "client_id": ACCESS_ID, "sign": sign, "t": t, "sign_method": "HMAC-SHA256",
    };

    try {
        const response = await axios.get(`${BASE_URL}/v1.0/token${query}`, { headers });
        
        if (response.data && response.data.success) {
            return response.data.result.access_token;
        } else {
            console.error("❌ ERROR DE AUTENTICACIÓN TUYA:", response.data);
            return null;
        }
    } catch (error) {
        return null;
    }
}

// ----------------------------------------------------
// 4. FUNCIÓN DE AYUDA PARA FIRMAR SOLICITUDES (GET/POST)
// ----------------------------------------------------
function signRequest(method, path, query, body, accessToken, t) {
    const bodyString = body ? JSON.stringify(body) : '';
    const bodyHash = crypto.createHash('sha256').update(bodyString, 'utf8').digest('hex');
    
    const stringToSign = [ method, bodyHash, '', path + query ].join('\n');
    const str = ACCESS_ID + (accessToken || '') + t + stringToSign; 

    const sign = crypto
        .createHmac("sha256", Buffer.from(SECRET_KEY, 'utf8'))
        .update(str, "utf8")
        .digest("hex")
        .toUpperCase();
    
    return {
        "client_id": ACCESS_ID,
        "access_token": accessToken,
        "t": t,
        "sign": sign,
        "sign_method": "HMAC-SHA256",
        "Content-Type": "application/json"
    };
}

// ----------------------------------------------------
// 5. FUNCIÓN PARA OBTENER EL ESTADO ACTUAL DE LA VÁLVULA (Necesario para automatización)
// ----------------------------------------------------
async function getValveStatus() {
    try {
        const accessToken = await getAccessToken();
        if (!accessToken) return false;

        const method = 'GET';
        const path = `/v1.0/devices/${DEVICE_ID_VALVE}`;
        const t = Date.now().toString();

        const headers = signRequest(method, path, '', null, accessToken, t);

        const response = await axios.get(`${BASE_URL}${path}`, { headers });
        
        if (response.data && response.data.success) {
            const statusList = response.data.result.status;
            const valveStatus = statusList.find(s => s.code === 'switch_1');
            return valveStatus ? valveStatus.value : false; 
        }
        return false;
    } catch (e) {
        return false;
    }
}


// ----------------------------------------------------
// 6. FUNCIÓN CENTRAL DE CONTROL (ABRIR/CERRAR)
// ----------------------------------------------------
async function controlValvula(isOpen, accessToken) {
    if (!DEVICE_ID_VALVE) return { success: false, msg: "Device ID no definido." };

    const COMMAND_CODE = "switch_1";
    const commands = {
        commands: [{ code: COMMAND_CODE, value: isOpen }]
    };

    const method = 'POST';
    const path = `/v1.0/devices/${DEVICE_ID_VALVE}/commands`;
    const t = Date.now().toString();

    const headers = signRequest(method, path, '', commands, accessToken, t);

    try {
        console.log(`[Tuya] Enviando comando: ${isOpen ? 'ABRIR' : 'CERRAR'} a la válvula.`);

        const response = await axios.post(`${BASE_URL}${path}`, commands, { headers });

        if (response.data.success) {
            console.log(`✅ [Tuya] Comando ${isOpen ? 'ABRIR' : 'CERRAR'} enviado OK.`);
        } else {
            console.error("❌ [Tuya ERROR]: ", response.data.msg);
        }
        return response.data;
    } catch (error) {
        console.error("❌ [Error de Red]: Fallo de conexión a la API de Tuya.", error.message);
        return { success: false, msg: error.message };
    }
}


// ----------------------------------------------------
// 7. FUNCIÓN PARA PROGRAMAR EL CIERRE AUTOMÁTICO (Programación por tiempo)
// ----------------------------------------------------
async function scheduleAutoClose(durationMinutes) {
    if (autoCloseTimer) {
        clearTimeout(autoCloseTimer);
        console.log('[PROGRAMACIÓN] Temporizador anterior cancelado.');
    }

    const durationMilliseconds = durationMinutes * 60 * 1000;
    
    console.log(`[PROGRAMACIÓN] Válvula ABIERTA. Se programará el CIERRE en ${durationMinutes} minutos.`);

    autoCloseTimer = setTimeout(async () => {
        console.log(`[PROGRAMACIÓN] ¡Tiempo agotado (${durationMinutes} minutos)! Intentando CIERRE automático.`);
        
        const accessToken = await getAccessToken(); 
        
        if (accessToken) {
            await controlValvula(false, accessToken); 
        } else {
            console.error('[PROGRAMACIÓN] CIERRE FALLIDO: No se pudo obtener un Access Token válido.');
        }

        autoCloseTimer = null; 
    }, durationMilliseconds);
}


// ----------------------------------------------------
// 8. FUNCIÓN DE LÓGICA AUTOMÁTICA (RIEGOSENSOR)
// ----------------------------------------------------
async function checkAutoIrrigation() {
    const isValveOpen = await getValveStatus(); 

    if (lastKnownHumidity <= HUMIDITY_THRESHOLD) {
        // Tierra seca: Iniciar riego si la válvula está cerrada
        if (!isValveOpen) {
            console.log(`[AUTOMÁTICO] Humedad (${lastKnownHumidity}%) < Umbral (${HUMIDITY_THRESHOLD}%). Iniciando riego.`);
            const accessToken = await getAccessToken();
            await controlValvula(true, accessToken); 
        } 
    } else if (lastKnownHumidity > HUMIDITY_THRESHOLD + HUMIDITY_MARGIN) { 
        // Tierra húmeda: Detener riego si la válvula está abierta
        if (isValveOpen) {
            console.log(`[AUTOMÁTICO] Humedad (${lastKnownHumidity}%) > Umbral. Deteniendo riego.`);
            const accessToken = await getAccessToken();
            await controlValvula(false, accessToken); 
            
            if (autoCloseTimer) {
                clearTimeout(autoCloseTimer);
                autoCloseTimer = null;
                console.log('[PROGRAMACIÓN] Cierre automático por humedad. Temporizador de cierre manual CANCELADO.');
            }
        } 
    }
}

// ----------------------------------------------------
// 9. ENDPOINT PARA RECIBIR DATOS DEL SENSOR (Automatización)
// ----------------------------------------------------
app.post('/api/data/sensor', (req, res) => {
    const { humidity } = req.body; 

    if (typeof humidity !== 'number' || humidity < 0 || humidity > 100) {
        return res.status(400).send({ status: 'error', message: 'Datos de humedad inválidos.' });
    }

    lastKnownHumidity = humidity;
    console.log(`[SENSOR] Nueva lectura de humedad recibida: ${lastKnownHumidity}%`);
    
    checkAutoIrrigation(); 

    res.status(200).send({ status: 'success', message: 'Dato recibido.' });
});


// ----------------------------------------------------
// 10. ENDPOINT DE AUTENTICACIÓN (LOGIN)
// ----------------------------------------------------
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (username === STATIC_USERNAME && password === STATIC_PASSWORD) {
<<<<<<< HEAD
        // Generar un token simple 
        const token = crypto.createHash('sha256').update(STATIC_USERNAME + SESSION_TOKEN_SECRET + Date.now()).digest('hex');
        
        console.log(`✅ USUARIO AUTENTICADO: ${username}. Token generado.`);
=======
        // Generar un token simple (simulando una firma segura)
        const token = crypto.createHash('sha256').update(STATIC_USERNAME + SESSION_TOKEN_SECRET + Date.now()).digest('hex');
        
        console.log(`✅ USUARIO AUTENTICADO: ${username}. Token generado.`);
        // Envía el token al frontend (APK)
>>>>>>> f8454d7 (APLICAR CORRECCIÓN FINAL: Forzar escucha en 0.0.0.0 para AWS)
        return res.status(200).send({ status: 'success', message: 'Login exitoso.', token: token });
    } else {
        return res.status(401).send({ status: 'error', message: 'Credenciales inválidas.' });
    }
});


// ----------------------------------------------------
<<<<<<< HEAD
// 11. MIDDLEWARE DE SEGURIDAD (Función de Protección)
// ----------------------------------------------------
function protectRoute(req, res, next) {
    const token = req.headers['x-auth-token']; // Espera el token en el header

    if (token && token.length > 10) { 
        next(); 
    } else {
        res.status(403).send({ status: 'error', message: 'Acceso denegado. Token requerido o inválido.' });
    }
}

// ----------------------------------------------------
// 12. ENDPOINT REST para la app móvil (Control Protegido)
// ----------------------------------------------------
=======
// 11. ENDPOINT REST para la app móvil (Control Protegido)
// ----------------------------------------------------
// Protegido con el middleware 'protectRoute'
>>>>>>> f8454d7 (APLICAR CORRECCIÓN FINAL: Forzar escucha en 0.0.0.0 para AWS)
app.post('/api/control/valvula', protectRoute, async (req, res) => {
    const action = req.body.action;
    const durationMinutes = parseInt(req.body.durationMinutes) || 0; 

    if (action === 'open' || action === 'close') {
        const isOpen = action === 'open';
        const accessToken = await getAccessToken();

        if (!accessToken) {
            return res.status(500).send({ status: "error", message: "Token inválido o no disponible." });
        }

        const result = await controlValvula(isOpen, accessToken);

        if (result.success) {
            if (isOpen && durationMinutes > 0) {
                scheduleAutoClose(durationMinutes); 
            }
            if (!isOpen && autoCloseTimer) {
                clearTimeout(autoCloseTimer);
                autoCloseTimer = null;
                console.log('[PROGRAMACIÓN] Cierre manual detectado. Temporizador de cierre CANCELADO.');
            }
            
            return res.status(200).send({ status: "success", action: action });
        } else {
            return res.status(500).send({ status: "error", message: result.msg || "Internal Tuya error" });
        }
    } else {
        return res.status(400).send({ status: "error", message: "Invalid action." });
    }
});

// ----------------------------------------------------
// 12. MIDDLEWARE DE SEGURIDAD (Función de Protección)
// ----------------------------------------------------
function protectRoute(req, res, next) {
    const token = req.headers['x-auth-token']; // Espera el token en el header

    if (token && token.length > 10) { 
        next(); 
    } else {
        res.status(403).send({ status: 'error', message: 'Acceso denegado. Token requerido o inválido.' });
    }
}


// ----------------------------------------------------
// 13. ENDPOINT: Servir la Interfaz Web (Frontend de prueba)
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'control.html')); 
});


// ----------------------------------------------------
// 14. PRUEBA DE CONEXIÓN AL INICIAR EL SERVIDOR
// ----------------------------------------------------
async function testConnection() {
    console.log("-----------------------------------------");
    console.log("Prueba de Integración Tuya al Iniciar el sistema...");

    try {
        const accessToken = await getAccessToken();
        if (!accessToken) {
            console.error("❌ ERROR: No se pudo obtener el token de acceso. La conexión falló en el primer paso.");
            console.log("-----------------------------------------");
            return;
        }

        const method = 'GET';
        const path = `/v1.0/devices/${DEVICE_ID_VALVE}`;
        const t = Date.now().toString();

        const headers = signRequest(method, path, '', null, accessToken, t);
        
        const response = await axios.get(`${BASE_URL}${path}`, { headers });

        if (response.data && response.data.success) {
            console.log("✅ Conexión con Tuya exitosa.");
            const deviceName = response.data.result.name;
            console.log(`✅ Dispositivo [${deviceName}] encontrado y ONLINE.`);
        } else {
            console.error("❌ ERROR CRÍTICO: Fallo al obtener el dispositivo.");
            console.error("Respuesta de Tuya:", response.data);
        }
        console.log("-----------------------------------------");
    } catch (e) {
        console.log("-----------------------------------------");
    }
}

// ----------------------------------------------------
// 15. INICIAR EL SERVIDOR
// ----------------------------------------------------
<<<<<<< HEAD
// 🚨 CORRECCIÓN FINAL: Usar '0.0.0.0' para escuchar el tráfico externo de AWS
app.listen(PORT, '0.0.0.0', async () => { // <--- ESTA ES LA VERSIÓN FINAL CORRECTA
=======
app.listen(PORT, async () => {
>>>>>>> f8454d7 (APLICAR CORRECCIÓN FINAL: Forzar escucha en 0.0.0.0 para AWS)
    console.log(`Servidor de Backend TECNOSIS corriendo en http://0.0.0.0:${PORT}`);
    await testConnection(); 
});
});
