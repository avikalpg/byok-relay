{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm
    pkgs.python3
    pkgs.gcc
    pkgs.gnumake
  ];

  env = {
    NODE_ENV = "development";
  };
}
