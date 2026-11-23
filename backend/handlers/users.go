package handlers

import (
	"errors"
	"fmt"
	"log"

	"github.com/companyuser/backend/authn"
	"github.com/companyuser/backend/database"
	"github.com/companyuser/backend/middleware"
	"github.com/companyuser/backend/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// GET /api/v1/users/me - Dynamic implementation
func GetMe(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)

	// For superadmin, return basic auth context without company_users lookup
	if auth.Permissions["superadmin"] {
		return c.JSON(fiber.Map{
			"id":            auth.AuthUserID,
			"auth_user_id":  auth.AuthUserID,
			"name":          "Platform Superadmin",
			"email":         "superadmin@platform.com",
			"status":        "active",
			"company":       nil,
			"user_roles":    []interface{}{},  // Empty array for frontend compatibility
			"user_machines": []interface{}{},  // Empty array for frontend compatibility
			"permissions":   auth.Permissions, // Include permissions directly for superadmin
		})
	}

	// Find current user in database with relationships
	var user models.CompanyUser
	if err := database.DB.Preload("UserRoles.Role.RolePermissions.Permission").First(&user, "auth_user_id = ?", auth.AuthUserID).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "User not found"})
	}

	// Update auth context with user's company
	auth.CompanyUser = user
	auth.CompanyID = user.CompanyID

	return c.JSON(user)
}

// GET /api/v1/users - Dynamic implementation
func ListUsers(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)

	// Query database for users with simple approach
	var users []models.CompanyUser
	query := database.DB

	// Check for branch_id filter
	branchID := c.Query("branch_id")
	if branchID != "" {
		// Validate UUID
		if _, err := uuid.Parse(branchID); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid branch ID"})
		}
		query = query.Where("branch_id = ?", branchID)
	}

	// If not superadmin, only show users from same company
	if !auth.Permissions["superadmin"] {
		query = query.Where("company_id = ?", auth.CompanyID)
	}

	if err := query.Preload("MachineAssignments.Machine").Preload("Branch").Preload("Subdivision").Find(&users).Error; err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Failed to fetch users", "details": err.Error()})
	}

	// Manually load relationships for each user
	for i := range users {
		// Load company
		database.DB.First(&users[i].Company, "id = ?", users[i].CompanyID)
		// Load user roles
		database.DB.Preload("Role").Find(&users[i].UserRoles, "user_id = ?", users[i].ID)
	}

	return c.JSON(users)
}

// GET /api/v1/users/:id - Dynamic implementation
func GetUser(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)
	userID := c.Params("id")

	// Find user in database
	var user models.CompanyUser
	if err := database.DB.Preload("Company").Preload("Branch").Preload("Subdivision").Preload("UserRoles.Role").First(&user, "id = ?", userID).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "User not found"})
	}

	// Check permissions - can only view users in same company unless superadmin
	if !auth.Permissions["superadmin"] && user.CompanyID != auth.CompanyID {
		return c.Status(403).JSON(fiber.Map{"error": "Access denied"})
	}

	return c.JSON(user)
}

// POST /api/v1/users - Create user in both auth.users and company_users tables
func CreateUser(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)

	var req struct {
		Name          string `json:"name"`
		Email         string `json:"email"`
		RoleID        string `json:"role_id"`
		Password      string `json:"password"`       // For initial user creation
		CompanyID     string `json:"company_id"`     // For superadmin to specify company
		BranchID      string `json:"branch_id"`      // Branch assignment within company
		SubdivisionID string `json:"subdivision_id"` // Subdivision assignment within branch
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	// Determine which company to use
	var targetCompanyID uuid.UUID
	if auth.Permissions["superadmin"] && req.CompanyID != "" {
		// Superadmin can specify company - validate it exists
		var company models.Company
		if err := database.DB.First(&company, "id = ?", req.CompanyID).Error; err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid company ID"})
		}
		targetCompanyID = models.MustParseUUID(req.CompanyID)
	} else if auth.Permissions["superadmin"] && req.CompanyID == "" {
		// Superadmin must specify company when creating users
		return c.Status(400).JSON(fiber.Map{"error": "Superadmin must specify a company when creating users"})
	} else if auth.CompanyID == uuid.Nil {
		// Non-superadmin without company (shouldn't happen)
		return c.Status(403).JSON(fiber.Map{"error": "Cannot create users without company assignment"})
	} else {
		// Regular users can only create users in their own company
		targetCompanyID = auth.CompanyID
	}

	// Validate and parse branch_id if provided
	var branchID *uuid.UUID
	if req.BranchID != "" {
		// Validate that branch exists and belongs to the target company
		var branch models.Branch
		if err := database.DB.First(&branch, "id = ? AND company_id = ?", req.BranchID, targetCompanyID).Error; err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid branch ID or branch does not belong to the specified company"})
		}
		parsedBranchID := models.MustParseUUID(req.BranchID)
		branchID = &parsedBranchID
	}

	// Validate and parse subdivision_id if provided
	var subdivisionID *uuid.UUID
	if req.SubdivisionID != "" {
		// Validate that subdivision exists and belongs to the specified branch
		var subdivision models.Subdivision
		if branchID == nil {
			return c.Status(400).JSON(fiber.Map{"error": "Cannot assign subdivision without branch assignment"})
		}
		if err := database.DB.First(&subdivision, "id = ? AND branch_id = ? AND company_id = ?", req.SubdivisionID, *branchID, targetCompanyID).Error; err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid subdivision ID or subdivision does not belong to the specified branch"})
		}
		parsedSubdivisionID := models.MustParseUUID(req.SubdivisionID)
		subdivisionID = &parsedSubdivisionID
	}

	var roleID uuid.UUID
	if req.RoleID != "" {
		parsed, err := uuid.Parse(req.RoleID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid role ID"})
		}
		roleID = parsed
	}

	// Create the login identity, company user and role together.
	var user models.CompanyUser
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		authUserID, err := authn.CreateUser(tx, req.Email, req.Password, req.Name)
		if err != nil {
			return err
		}
		user = models.CompanyUser{
			CompanyID:     targetCompanyID,
			BranchID:      branchID,
			SubdivisionID: subdivisionID,
			AuthUserID:    authUserID,
			Name:          req.Name,
			Email:         authn.NormalizeEmail(req.Email),
			Status:        "active",
		}
		if err := tx.Create(&user).Error; err != nil {
			return fmt.Errorf("create user: %w", err)
		}
		if roleID != uuid.Nil {
			if err := tx.Create(&models.UserRole{UserID: user.ID, RoleID: roleID}).Error; err != nil {
				return fmt.Errorf("assign role: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return authUserError(c, err, "Failed to create user")
	}

	// Load relationships
	database.DB.Preload("Company").Preload("Branch").Preload("Subdivision").Preload("UserRoles.Role").First(&user, "id = ?", user.ID)

	return c.Status(201).JSON(user)
}

// authUserError maps login-identity validation errors to 400/409 responses.
func authUserError(c *fiber.Ctx, err error, fallback string) error {
	switch {
	case errors.Is(err, authn.ErrEmailTaken):
		return c.Status(409).JSON(fiber.Map{"error": err.Error()})
	case errors.Is(err, authn.ErrInvalidEmail), errors.Is(err, authn.ErrWeakPassword):
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	log.Printf("users: %v", err)
	return c.Status(500).JSON(fiber.Map{"error": fallback})
}

// PUT /api/v1/users/:id - Dynamic implementation
func UpdateUser(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)
	userID := c.Params("id")

	var req struct {
		Name          string  `json:"name"`
		Email         string  `json:"email"`
		RoleID        string  `json:"role_id"`
		BranchID      *string `json:"branch_id"`      // Pointer to distinguish between null, empty, and value
		SubdivisionID *string `json:"subdivision_id"` // Pointer to distinguish between null, empty, and value
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	// Find user in database
	var user models.CompanyUser
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "User not found"})
	}

	// Check permissions - can only edit users in same company unless superadmin
	if !auth.Permissions["superadmin"] && user.CompanyID != auth.CompanyID {
		return c.Status(403).JSON(fiber.Map{"error": "Access denied"})
	}

	// Update user
	oldEmail := user.Email
	user.Name = req.Name
	user.Email = authn.NormalizeEmail(req.Email)
	emailChanged := user.Email != authn.NormalizeEmail(oldEmail)

	// Update branch if provided in request
	if req.BranchID != nil {
		if *req.BranchID == "" {
			// Empty string explicitly clears the branch
			user.BranchID = nil
			user.SubdivisionID = nil // Clear subdivision when branch is cleared
		} else {
			// Validate that branch exists and belongs to the user's company
			var branch models.Branch
			if err := database.DB.First(&branch, "id = ? AND company_id = ?", *req.BranchID, user.CompanyID).Error; err != nil {
				return c.Status(400).JSON(fiber.Map{"error": "Invalid branch ID or branch does not belong to the user's company"})
			}
			parsedBranchID := models.MustParseUUID(*req.BranchID)
			user.BranchID = &parsedBranchID
		}
	}
	// If req.BranchID is nil, don't modify the existing branch assignment

	// Update subdivision if provided in request
	if req.SubdivisionID != nil {
		if *req.SubdivisionID == "" {
			// Empty string explicitly clears the subdivision
			user.SubdivisionID = nil
		} else {
			// Validate that subdivision exists and belongs to the user's branch
			if user.BranchID == nil {
				return c.Status(400).JSON(fiber.Map{"error": "Cannot assign subdivision without branch assignment"})
			}
			var subdivision models.Subdivision
			if err := database.DB.First(&subdivision, "id = ? AND branch_id = ? AND company_id = ?", *req.SubdivisionID, *user.BranchID, user.CompanyID).Error; err != nil {
				return c.Status(400).JSON(fiber.Map{"error": "Invalid subdivision ID or subdivision does not belong to the user's branch"})
			}
			parsedSubdivisionID := models.MustParseUUID(*req.SubdivisionID)
			user.SubdivisionID = &parsedSubdivisionID
		}
	}
	// If req.SubdivisionID is nil, don't modify the existing subdivision assignment

	// The login email lives in app_users; keep both in step.
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		if emailChanged {
			if err := authn.UpdateEmail(tx, user.AuthUserID, user.Email); err != nil {
				return err
			}
		}
		return tx.Save(&user).Error
	})
	if err != nil {
		return authUserError(c, err, "Failed to update user")
	}

	// Update role assignment
	if req.RoleID != "" {
		// Delete existing role assignments
		database.DB.Where("user_id = ?", user.ID).Delete(&models.UserRole{})

		// Create new role assignment
		userRole := models.UserRole{
			UserID: user.ID,
			RoleID: models.MustParseUUID(req.RoleID),
		}
		if err := database.DB.Create(&userRole).Error; err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to assign role"})
		}
	}

	// Reload with relationships
	if err := database.DB.Preload("Company").Preload("Branch").Preload("Subdivision").Preload("UserRoles.Role").First(&user, "id = ?", userID).Error; err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Failed to reload user"})
	}

	return c.JSON(user)
}

// DELETE /api/v1/users/:id - Dynamic implementation
func DeleteUser(c *fiber.Ctx) error {
	auth := middleware.GetAuth(c)
	userID := c.Params("id")

	// Find user in database
	var user models.CompanyUser
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "User not found"})
	}

	// Self-deletion protection (userID is the company_users id, so compare
	// the login identity behind it).
	if user.AuthUserID == auth.AuthUserID {
		return c.Status(400).JSON(fiber.Map{"error": "Cannot delete your own account"})
	}

	// Check permissions - can only delete users in same company unless superadmin
	if !auth.Permissions["superadmin"] && user.CompanyID != auth.CompanyID {
		return c.Status(403).JSON(fiber.Map{"error": "Access denied"})
	}

	// Delete the company user and its login identity (sessions cascade).
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&user).Error; err != nil {
			return err
		}
		return authn.DeleteUser(tx, user.AuthUserID)
	})
	if err != nil {
		log.Printf("delete user %s: %v", user.ID, err)
		return c.Status(500).JSON(fiber.Map{"error": "Failed to delete user"})
	}

	return c.JSON(fiber.Map{"message": "User deleted successfully"})
}
