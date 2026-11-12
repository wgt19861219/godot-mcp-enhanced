# D6 真机验证 fixture:仅存在于项目 .gutconfig.json 的 dirs(替换语义判据)——
# 若 -gconfig=<tmp> 被附加合并而非替换,delta 会被误执行,片计数将多出 1 个测试
extends GutTest


func test_delta_should_never_run_under_gconfig_replacement() -> void:
	assert_true(true)
