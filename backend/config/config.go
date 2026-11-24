package config

import (
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL string
	// JWTSecret signs the access tokens issued by /auth/login (HS256).
	// Must be a long random string (at least 32 characters).
	JWTSecret string
	Port      string
	// WSPort serves the live-data WebSocket (/ws) on its own listener. When it
	// equals Port, /ws is only served by the main listener.
	WSPort string
	// DBMaxConns is the database pool size. Defaults to 1 for poolers that break
	// with concurrent prepared statements; raise it on a direct Postgres server.
	DBMaxConns int

	// WebRTC ICE servers for the remote camera feature.
	// TURN is required when the two peers are on different networks (NAT traversal).
	// Defaults point at the free public OpenRelay (Metered) TURN servers for testing;
	// override with your own (e.g. self-hosted coturn or Twilio) in production.
	StunURL        string
	TurnURL        string
	TurnUsername   string
	TurnCredential string

	// OPC UA server endpoint for real machine data ingestion
	OPCUAEndpoint string
	OPCUAUsername string
	OPCUAPassword string
	// Machine codes (comma-separated) read from OPCUAEndpoint by the built-in
	// demo client (opcua_client.go). Empty = client idle.
	OPCUADemoMachines string

	// Demo data simulator (simulator.go). On until the OPC UA gateway goes live.
	SimulatorEnabled bool
}

var Cfg Config

func Load() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, reading from environment")
	}

	Cfg = Config{
		DatabaseURL: mustGet("DATABASE_URL"),
		JWTSecret:   mustGet("JWT_SECRET"),
		Port:        getOr("PORT", "8080"),
		WSPort:      getOr("WS_PORT", "9000"),
		DBMaxConns:  getInt("DB_MAX_CONNS", 1),

		StunURL:        getOr("STUN_URL", "stun:stun.l.google.com:19302"),
		TurnURL:        getOr("TURN_URL", "turn:openrelay.metered.ca:80"),
		TurnUsername:   getOr("TURN_USERNAME", "openrelayproject"),
		TurnCredential: getOr("TURN_CREDENTIAL", "openrelayproject"),

		OPCUAEndpoint:     getOr("OPCUA_ENDPOINT", "opc.tcp://146.196.46.162:4840/abhipsita/abexon"), // TODO: make dynamic
		OPCUADemoMachines: getOr("OPCUA_DEMO_MACHINES", ""),
		OPCUAUsername:     getOr("OPCUA_USERNAME", ""),
		OPCUAPassword:     getOr("OPCUA_PASSWORD", ""),

		SimulatorEnabled: getOr("SIMULATOR_ENABLED", "true") != "false",
	}

	// Hosting dashboards often keep the quotes pasted around a value. pgx does not
	// fail on a malformed URL: it silently falls back to the local socket as the OS
	// user (host=/var/run/postgresql user=root), so reject anything unusable here.
	Cfg.DatabaseURL = strings.Trim(strings.TrimSpace(Cfg.DatabaseURL), `"'`)
	if !strings.HasPrefix(Cfg.DatabaseURL, "postgres://") && !strings.HasPrefix(Cfg.DatabaseURL, "postgresql://") {
		log.Fatal("DATABASE_URL must start with postgres:// or postgresql:// (check the value set on the server)")
	}

	if len(Cfg.JWTSecret) < 32 {
		log.Fatal("JWT_SECRET must be at least 32 characters")
	}
}

func mustGet(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("Required env var %s is not set", key)
	}
	return v
}

func getOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		log.Fatalf("%s must be a positive integer", key)
	}
	return n
}
