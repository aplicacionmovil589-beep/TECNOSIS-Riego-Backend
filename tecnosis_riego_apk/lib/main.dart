import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

// 🚨 1. AJUSTAR ESTE HOST: IP y PUERTO de tu servidor Node.js
// Utiliza la IP que obtuviste: 192.168.1.45
const String API_BASE_URL_HOST = '13.220.6.167:3000'; 
const String CONTROL_ENDPOINT_PATH = '/api/control/valvula';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'TECNOSIS Riego App',
      theme: ThemeData(primarySwatch: Colors.green),
      home: const ControlScreen(),
    );
  }
}

class ControlScreen extends StatefulWidget {
  const ControlScreen({super.key});

  @override
  State<ControlScreen> createState() => _ControlScreenState();
}

class _ControlScreenState extends State<ControlScreen> {
  String _statusMessage = "Esperando comando...";
  int _durationMinutes = 5; // Valor inicial de la duración
  
  // 🚨 CORRECCIÓN CLAVE: Controlador de texto para gestionar la entrada
  late TextEditingController _durationController;

  @override
  void initState() {
    super.initState();
    // Inicializa el controlador con el valor inicial de la variable de estado
    _durationController = TextEditingController(text: _durationMinutes.toString());
  }
  
  @override
  void dispose() {
    _durationController.dispose();
    super.dispose();
  }

  // ----------------------------------------------------
  // FUNCIÓN PRINCIPAL PARA COMUNICARSE CON EL BACKEND NODE.JS
  // ----------------------------------------------------
  Future<void> controlValvula(String action) async {
    // Sincroniza la variable de estado justo antes de enviar
    _durationMinutes = int.tryParse(_durationController.text) ?? 1;
    
    final int durationToSend = action == 'open' ? _durationMinutes : 0;

    setState(() {
      _statusMessage = "Enviando comando: ${action.toUpperCase()}...";
    });

    try {
      // Usar Uri.http() para evitar el error de corchetes IPv6.
      final uri = Uri.http(API_BASE_URL_HOST, CONTROL_ENDPOINT_PATH); 
      
      final response = await http.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'action': action,
          'durationMinutes': durationToSend, // Envía el valor sincronizado
        }),
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        if (data['status'] == 'success') {
          String msg = "Válvula ${action.toUpperCase()} OK.";
          if (action == 'open' && durationToSend > 0) {
            msg = "Válvula ABIERTA OK. Cierre programado en $durationToSend min.";
          }
          setState(() {
            _statusMessage = '✅ $msg';
          });
        } else {
          setState(() {
            _statusMessage = '❌ ERROR: ${data['message'] ?? 'Fallo en el backend.'}';
          });
        }
      } else {
        setState(() {
          _statusMessage = '❌ ERROR HTTP: Servidor devolvió ${response.statusCode}. ¿Está Node.js corriendo?';
        });
      }
    } catch (e) {
      setState(() {
        _statusMessage = '❌ ERROR DE CONEXIÓN: Verifica que el servidor (${API_BASE_URL_HOST}) esté activo y con la IP correcta.';
      });
      print(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('TECNOSIS Riego Control')),
      // Usar SingleChildScrollView para evitar el desbordamiento (overflow)
      body: SingleChildScrollView( 
        child: Padding(
          padding: const EdgeInsets.all(20.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // Campo de Duración
              const Text('Duración del Riego (minutos):', style: TextStyle(fontSize: 16)),
              TextField(
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                maxLength: 3, 
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  hintText: '5',
                  counterText: "" 
                ),
                // 🚨 CORRECCIÓN: Usar el controlador de estado
                controller: _durationController, 
              ),
              const SizedBox(height: 20),

              // Botón ABRIR (Programado)
              ElevatedButton(
                onPressed: () => controlValvula('open'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.green,
                  padding: const EdgeInsets.symmetric(vertical: 15),
                ),
                child: const Text('ABRIR VÁLVULA (Programado)', style: TextStyle(fontSize: 18, color: Colors.white)),
              ),
              const SizedBox(height: 15),

              // Botón CERRAR (Manual)
              ElevatedButton(
                onPressed: () => controlValvula('close'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  padding: const EdgeInsets.symmetric(vertical: 15),
                ),
                child: const Text('CERRAR VÁLVULA (Manual)', style: TextStyle(fontSize: 18, color: Colors.white)),
              ),
              const SizedBox(height: 30),

              // Mensaje de Estado
              Text(_statusMessage,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: _statusMessage.startsWith('✅') ? Colors.green.shade700 : Colors.black87)
              ),
            ],
          ),
        ),
      ),
    );
  }
}