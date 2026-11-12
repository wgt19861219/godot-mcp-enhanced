# D6 真机验证 fixture:片内 pass 用例 + GODOT_TEST_MODE 透传探针(ENVMARK 行由驱动脚本抓取比对)
extends GutTest


func test_alpha_one() -> void:
	assert_true(true)


func test_alpha_env_probe() -> void:
	print("ENVMARK:" + OS.get_environment("GODOT_TEST_MODE"))
	assert_true(true)
