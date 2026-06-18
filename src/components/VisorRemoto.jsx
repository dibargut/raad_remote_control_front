import React, { useEffect, useRef, useState } from 'react';

const FIXED_BACKEND_IP = "192.168.1.135"; 
const BACKEND_PORT = "8080";
const SESSION_UUID = "test-session-123";

export function VisorRemoto() {
    const [token, setToken] = useState(localStorage.getItem('guardian_token') || '');
    const [password, setPassword] = useState('');
    const [errorLogin, setErrorLogin] = useState('');
    const [estadoP2P, setEstadoP2P] = useState('Desconectado'); // Para monitorizar el estado real
    
    const imageRef = useRef(null);
    const peerConnectionRef = useRef(null);
    const dataChannelRef = useRef(null);
    const socketRef = useRef(null);
    
    // 🚀 COLA DE SEGURIDAD: Evita que los candidatos ICE de Rust se pierdan antes del Answer
    const candidatosEnColaRef = useRef([]);

    const manejarLogin = async (e) => {
        e.preventDefault();
        setErrorLogin('');
        try {
            const respuesta = await fetch(`http://${FIXED_BACKEND_IP}:${BACKEND_PORT}/api/remote/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password })
            });

            if (respuesta.ok) {
                const data = await respuesta.json();
                localStorage.setItem('guardian_token', data.access_token);
                setToken(data.access_token);
            } else {
                setErrorLogin('Contraseña incorrecta o rechazada por el SRA.');
            }
        } catch (err) {
            setErrorLogin('Error de red: No se pudo conectar con el servidor FastAPI.');
        }
    };

    // Función para poder lanzar el Handshake bajo demanda si el agente se inicia después
    const forzarHandshakeSDP = async () => {
        const pc = peerConnectionRef.current;
        const ws = socketRef.current;
        if (pc && ws && ws.readyState === WebSocket.OPEN) {
            console.log("[Señalización] Forzando generación de Oferta WebRTC...");
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
        }
    };

    useEffect(() => {
        if (!token) return;

        const wsUrl = `ws://${FIXED_BACKEND_IP}:${BACKEND_PORT}/api/remote/signaling/${SESSION_UUID}/visor?token=${token}`;
        console.log("[Señalización] Conectando a:", wsUrl);
        
        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        peerConnectionRef.current = pc;

        // Monitorizar cambios en la pila física de WebRTC
        pc.onconnectionstatechange = () => {
            console.log("[WebRTC-Estado]:", pc.connectionState);
            setEstadoP2P(pc.connectionState);
        };

        const dc = pc.createDataChannel("video_stream", { ordered: false, maxRetransmits: 0 });
        dataChannelRef.current = dc;
        dc.binaryType = "arraybuffer";

        dc.onmessage = (msg) => {
            const arrayBuffer = msg.data;

            // 🚀 INTERCEPCIÓN DE DIAGNÓSTICO: Detectar si Rust nos mandó el Ping de validación de 4 bytes
            if (arrayBuffer.byteLength === 4) {
                const texto = new TextDecoder().decode(arrayBuffer);
                if (texto === "PING") {
                    console.log("%c[DIAGNÓSTICO-ÉXITO] ¡Ping de 4 bytes recibido desde Rust! El DataChannel es bidireccional.", "color: #00ff00; font-weight: bold;");
                    return; // Cortamos flujo para que no intente renderizarse como JPEG roto
                }
            }

            // Procesar frame normal de vídeo
            const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
            if (imageRef.current) {
                const viejaUrl = imageRef.current.src;
                imageRef.current.src = URL.createObjectURL(blob);
                if (viejaUrl && viejaUrl.startsWith('blob:')) {
                    URL.revokeObjectURL(viejaUrl);
                }
            }
        };

        dc.onopen = () => console.log("¡Túnel P2P Abierto desde el Visor!");

        pc.onicecandidate = (event) => {
            if (event.candidate && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
        };

        ws.onopen = async () => {
            console.log("[Señalización] Conectado a FastAPI. Generando Oferta inicial...");
            await forzarHandshakeSDP();
        };

        ws.onmessage = async (msg) => {
            const data = JSON.parse(msg.data);
            console.log("[Señalización] Mensaje recibido:", data.type);

            if (data.type === 'answer') {
                console.log("[WebRTC] Respuesta SDP recibida de Rust. Aplicando a la sesión local...");
                await pc.setRemoteDescription(new RTCSessionDescription(data));
                
                // 🚀 VACIAR COLA: Ahora que tenemos RemoteDescription, inyectamos los candidatos pendientes
                console.log(`[WebRTC] Procesando ${candidatosEnColaRef.current.length} candidatos ICE acumulados en cola.`);
                while (candidatosEnColaRef.current.length > 0) {
                    const candidate = candidatosEnColaRef.current.shift();
                    await pc.addIceCandidate(candidate).catch(e => console.error("Error aplicando candidato en cola:", e));
                }
            } else if (data.type === 'candidate') {
                const iceCandidate = new RTCIceCandidate(data.candidate);
                if (pc.remoteDescription) {
                    // Si ya tenemos la descripción remota lista, se aplica directamente
                    await pc.addIceCandidate(iceCandidate).catch(e => console.error("Error directo con candidato ICE:", e));
                } else {
                    // Si llega antes del Answer de Rust, lo guardamos para evitar el Crash del estado
                    console.log("[WebRTC] Guardando candidato ICE en cola temporal (Falta Answer remoto)...");
                    candidatosEnColaRef.current.push(iceCandidate);
                }
            }
        };

        ws.onerror = (e) => {
            console.error("[Señalización] Error en WebSocket:", e);
            localStorage.removeItem('guardian_token');
            setToken('');
        };

        return () => {
            ws.close();
            pc.close();
            candidatosEnColaRef.current = [];
        };
    }, [token]);

    const manejarInteraccionPeriferico = (eventoTipo, e) => {
        if (!dataChannelRef.current || dataChannelRef.current.readyState !== "open") return;

        const rect = e.target.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const comando = {
            event: eventoTipo,
            x_píxel: x,
            y_píxel: y,
            w_nativa: rect.width,
            h_nativa: rect.height,
            button: e.button === 2 ? "right" : "left",
            key: e.key || "",
            deltaY: e.deltaY || 0
        };

        dataChannelRef.current.send(JSON.stringify(comando));
    };

    if (!token) {
        return (
            <div style={{ width: '100vw', height: '100vh', backgroundColor: '#1e1e24', display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: 'sans-serif' }}>
                <form onSubmit={manejarLogin} style={{ backgroundColor: '#2a2a35', padding: '30px', borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.3)', width: '320px' }}>
                    <h3 style={{ color: '#fff', margin: '0 0 20px 0', textAlign: 'center' }}>Guardian SRA - Acceso</h3>
                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ color: '#bbb', display: 'block', marginBottom: '5px', fontSize: '14px' }}>Contraseña de Sesión:</label>
                        <input 
                            type="password" 
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #444', backgroundColor: '#1e1e24', color: '#fff', boxSizing: 'border-box' }}
                            required
                        />
                    </div>
                    {errorLogin && <p style={{ color: '#ff6b6b', fontSize: '13px', margin: '0 0 15px 0' }}>{errorLogin}</p>}
                    <button type="submit" style={{ width: '100%', padding: '10px', border: 'none', borderRadius: '4px', backgroundColor: '#007acc', color: '#fff', fontWeight: 'bold', cursor: 'pointer' }}>
                        Conectar al Agente
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div 
            style={{ width: '100vw', height: '100vh', backgroundColor: '#111', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {/* HUD superior de diagnóstico técnico */}
            <div style={{ position: 'absolute', top: '10px', left: '10px', display: 'flex', gap: '10px', zIndex: 10 }}>
                <span style={{ padding: '6px 12px', backgroundColor: '#222', color: estadoP2P === 'connected' ? '#00ff00' : '#ffaa00', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace', border: '1px solid #444' }}>
                    P2P: {estadoP2P.toUpperCase()}
                </span>
                <button 
                    onClick={forzarHandshakeSDP}
                    style={{ padding: '6px 12px', backgroundColor: '#007acc', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                >
                    🔄 Forzar Handshake (Oferta)
                </button>
            </div>

            <img 
                ref={imageRef}
                alt="Esperando enlace P2P con el dispositivo remoto..."
                style={{ maxWidth: '100%', maxHeight: '100%', cursor: 'crosshair', color: '#fff' }}
                onMouseMove={(e) => manejarInteraccionPeriferico("mouse_move", e)}
                onMouseDown={(e) => manejarInteraccionPeriferico("mouse_down", e)}
                onMouseUp={(e) => manejarInteraccionPeriferico("mouse_up", e)}
            />
            
            <button 
                onClick={() => { localStorage.removeItem('guardian_token'); setToken(''); }}
                style={{ position: 'absolute', top: '10px', right: '10px', padding: '6px 12px', backgroundColor: '#cc3333', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', zIndex: 10 }}
            >
                Cerrar Sesión
            </button>
        </div>
    );
}