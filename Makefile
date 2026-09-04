.PHONY: test build check smoke-braf acceptance-all acceptance-local acceptance-grch37 acceptance-grch38 acceptance-devices acceptance-devices-grch37 acceptance-devices-grch38

test:
	cargo test -p dgw-core
	cargo test -p dgw-mcp
	npm test

build:
	npm run build

check: test build

smoke-braf: acceptance-grch37

acceptance-all: acceptance-local acceptance-devices

acceptance-local: acceptance-grch37 acceptance-grch38

acceptance-devices: acceptance-devices-grch37 acceptance-devices-grch38

acceptance-grch37:
	@set -e; \
	acceptance_root=$$(mktemp -d /tmp/dgw-acceptance-grch37.XXXXXX); \
	cargo run -p dgw-core --example local_smoke -- fixtures/braf-v600e.synthetic.vcf DGW_DEMO "$$acceptance_root/project.dgw" config/local-hs37d5.development.json; \
	echo "GRCh37 acceptance package: $$acceptance_root/project.dgw"

acceptance-grch38:
	@set -e; \
	acceptance_root=$$(mktemp -d /tmp/dgw-acceptance-grch38.XXXXXX); \
	cargo run -p dgw-core --example local_smoke -- fixtures/dgw-cluster.grch38.synthetic.vcf DGW_DEMO "$$acceptance_root/project.dgw" config/local-hg38.development.json; \
	echo "GRCh38 acceptance package: $$acceptance_root/project.dgw"

acceptance-devices-grch37:
	@set -e; \
	acceptance_root=$$(mktemp -d /tmp/dgw-device-acceptance-grch37.XXXXXX); \
	cargo run -p dgw-core --example device_acceptance -- fixtures/dgw-cluster.synthetic.vcf DGW_DEMO "$$acceptance_root/project.dgw" config/local-hs37d5.development.json; \
	echo "GRCh37 device acceptance package: $$acceptance_root/project.dgw"

acceptance-devices-grch38:
	@set -e; \
	acceptance_root=$$(mktemp -d /tmp/dgw-device-acceptance-grch38.XXXXXX); \
	cargo run -p dgw-core --example device_acceptance -- fixtures/dgw-cluster.grch38.synthetic.vcf DGW_DEMO "$$acceptance_root/project.dgw" config/local-hg38.development.json; \
	echo "GRCh38 device acceptance package: $$acceptance_root/project.dgw"
