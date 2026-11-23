package database

import (
	"database/sql"
	"log"

	"github.com/companyuser/backend/config"
	_ "github.com/lib/pq"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB
var RawDB *sql.DB // Direct SQL database connection

func Connect() {
	var err error
	DB, err = gorm.Open(postgres.Open(config.Cfg.DatabaseURL), &gorm.Config{
		Logger:                                   logger.Default.LogMode(logger.Silent),
		PrepareStmt:                              false, // Disable prepared statement caching
		DisableForeignKeyConstraintWhenMigrating: true,
		DisableAutomaticPing:                     true, // Disable automatic ping
	})
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}

	// Get direct SQL database connection
	RawDB, err = DB.DB()
	if err != nil {
		log.Fatalf("Failed to get raw database connection: %v", err)
	}

	// Pool size: 1 by default (safe behind poolers such as PgBouncer/Supavisor,
	// which conflict with concurrent prepared statements). On a direct Postgres
	// server set DB_MAX_CONNS (e.g. 10).
	RawDB.SetMaxOpenConns(config.Cfg.DBMaxConns)
	RawDB.SetMaxIdleConns(config.Cfg.DBMaxConns)
	RawDB.SetConnMaxLifetime(0) // Don't expire connections
	RawDB.SetConnMaxIdleTime(0) // Never close idle connections

	log.Println("Database connected")

	// Clear any existing prepared statements
	clearPreparedStatements()
}

// Clear any existing prepared statements to prevent conflicts
func clearPreparedStatements() {
	// Clear ALL prepared statements, not just cached ones
	if _, err := RawDB.Exec("DEALLOCATE ALL"); err != nil {
		log.Printf("Warning: Could not deallocate all statements: %v", err)
	} else {
		log.Println("Cleared all prepared statements")
	}
}
