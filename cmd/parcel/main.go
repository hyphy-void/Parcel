package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/hyphy-void/Parcel/internal/config"
	"github.com/hyphy-void/Parcel/internal/parcel"
	"github.com/hyphy-void/Parcel/web"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

func main() {
	if e := run(); e != nil {
		slog.Error("Parcel stopped", "error", e)
		os.Exit(1)
	}
}
func run() error {
	unix.Umask(0077)
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	if command == "version" {
		fmt.Println(parcel.Version)
		return nil
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	stdin := flags.Bool("password-stdin", false, "从标准输入读取管理员密码，用于自动化初始化")
	if e := flags.Parse(args); e != nil {
		return e
	}
	if command != "serve" && command != "admin-password" && command != "cleanup" {
		return fmt.Errorf("命令应为 serve、admin-password、cleanup 或 version")
	}
	c, e := config.Load()
	if e != nil {
		return e
	}
	level := slog.LevelInfo
	if e = level.UnmarshalText([]byte(c.LogLevel)); e != nil {
		return fmt.Errorf("LOG_LEVEL: %w", e)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)
	assets, e := fs.Sub(web.Assets, "dist")
	if e != nil {
		return e
	}
	a, e := parcel.New(c, assets, logger)
	if e != nil {
		return e
	}
	defer a.Close()
	if command == "admin-password" {
		var password string
		if *stdin {
			scanner := bufio.NewScanner(os.Stdin)
			scanner.Buffer(make([]byte, 512), 512)
			if !scanner.Scan() {
				return fmt.Errorf("未读取到密码")
			}
			password = scanner.Text()
		} else {
			fmt.Fprint(os.Stderr, "管理员新密码（至少 8 字节）：")
			b, e := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if e != nil {
				return e
			}
			password = string(b)
			fmt.Fprint(os.Stderr, "再次输入：")
			b, e = term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if e != nil {
				return e
			}
			if password != string(b) {
				return fmt.Errorf("两次密码不一致")
			}
		}
		if e = a.InitAdmin(strings.TrimRight(password, "\r\n")); e != nil {
			return e
		}
		fmt.Println("管理员密码已设置，旧登录会话已作废。")
		return nil
	}
	if command == "cleanup" {
		a.Cleanup()
		fmt.Println("清理完成。")
		return nil
	}
	if !a.AdminExists() {
		return fmt.Errorf("管理员尚未初始化，请先运行 parcel admin-password")
	}
	a.Start()
	server := &http.Server{Addr: c.Listen, Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	logger.Info("Parcel started", "listen", c.Listen, "base_url", c.BaseURL, "version", parcel.Version)
	select {
	case e := <-done:
		if e != nil && e != http.ErrServerClosed {
			return e
		}
		return nil
	case <-stop:
		logger.Info("Parcel shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if e := server.Shutdown(ctx); e != nil {
			server.Close()
		}
		return nil
	}
}
