locals {
  postgresql_database_name        = "researchagents"
  postgresql_master_username      = "researchadmin"
  postgresql_ssm_parameter_prefix = "/${var.project_name}/database/postgresql"
}

resource "random_password" "postgresql_master" {
  length           = 32
  special          = true
  override_special = "_-"
  min_lower        = 8
  min_upper        = 8
  min_numeric      = 8
  min_special      = 4
}

resource "aws_db_subnet_group" "postgresql" {
  name       = "${var.project_name}-postgresql"
  subnet_ids = [aws_subnet.public.id, aws_subnet.public_database.id]

  tags = {
    Name = "${var.project_name}-postgresql"
  }

  depends_on = [
    aws_route_table_association.public,
    aws_route_table_association.public_database,
  ]
}

resource "aws_security_group" "postgresql" {
  name_prefix = "${var.project_name}-postgresql-"
  description = "Public PostgreSQL access for the proof-of-concept database."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "PostgreSQL from the public internet"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "software_builder_database_client" {
  name_prefix = "${var.project_name}-software-builder-database-client-"
  description = "PostgreSQL egress for software-builder orchestrators."
  vpc_id      = aws_vpc.main.id

  egress {
    description     = "PostgreSQL to the proof-of-concept database"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.postgresql.id]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "postgresql" {
  identifier = "${var.project_name}-postgresql"

  engine         = "postgres"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = local.postgresql_database_name
  username = local.postgresql_master_username
  password = random_password.postgresql_master.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.postgresql.name
  vpc_security_group_ids = [aws_security_group.postgresql.id]
  publicly_accessible    = true
  multi_az               = false

  backup_retention_period    = 0
  delete_automated_backups   = true
  deletion_protection        = false
  skip_final_snapshot        = true
  auto_minor_version_upgrade = true
  apply_immediately          = true
}

resource "aws_ssm_parameter" "postgresql_host" {
  name        = "${local.postgresql_ssm_parameter_prefix}/host"
  description = "Hostname of the proof-of-concept PostgreSQL database."
  type        = "String"
  value       = aws_db_instance.postgresql.address
}

resource "aws_ssm_parameter" "postgresql_port" {
  name        = "${local.postgresql_ssm_parameter_prefix}/port"
  description = "Port of the proof-of-concept PostgreSQL database."
  type        = "String"
  value       = tostring(aws_db_instance.postgresql.port)
}

resource "aws_ssm_parameter" "postgresql_database_name" {
  name        = "${local.postgresql_ssm_parameter_prefix}/database-name"
  description = "Initial database name for the proof-of-concept PostgreSQL database."
  type        = "String"
  value       = aws_db_instance.postgresql.db_name
}

resource "aws_ssm_parameter" "postgresql_username" {
  name        = "${local.postgresql_ssm_parameter_prefix}/username"
  description = "Master username for the proof-of-concept PostgreSQL database."
  type        = "String"
  value       = aws_db_instance.postgresql.username
}

resource "aws_ssm_parameter" "postgresql_password" {
  name        = "${local.postgresql_ssm_parameter_prefix}/password"
  description = "Master password for the proof-of-concept PostgreSQL database."
  type        = "SecureString"
  value       = random_password.postgresql_master.result
}
