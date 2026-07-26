resource "aws_instance" "stress_test" {
  count = var.create_stress_test_instance ? 1 : 0

  ami                                  = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type                        = "t3.micro"
  subnet_id                            = aws_subnet.public.id
  vpc_security_group_ids               = [aws_security_group.instances.id]
  associate_public_ip_address          = true
  iam_instance_profile                 = aws_iam_instance_profile.stress_test[0].name
  instance_initiated_shutdown_behavior = "terminate"
  user_data_replace_on_change          = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    encrypted             = true
    delete_on_termination = true
    volume_size           = 8
    volume_type           = "gp3"
  }

  user_data = templatefile("${path.module}/templates/stress-test-user-data.sh.tftpl", {
    audit_bucket  = aws_s3_bucket.audit.id
    function_name = aws_lambda_function.subagent_manager.function_name
    stress_script = filebase64("${path.module}/../scripts/stress_test.py")
  })

  tags = {
    Name = "${var.project_name}-stress-test"
    Role = "stress-test-caller"
  }
}
