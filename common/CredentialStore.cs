using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security;

namespace BcDevToolset {
    public sealed class StoredCredential {
        public string UserName;
        public SecureString Password;
    }
    public static class CredentialStore {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Credential {
            public uint Flags, Type;
            public string TargetName, Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist, AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias, UserName;
        }
        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredWrite(ref Credential credential, uint flags);
        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredDelete(string target, uint type, uint flags);
        [DllImport("advapi32.dll")]
        private static extern void CredFree(IntPtr credential);

        private static void ValidateTarget(string target) {
            if (String.IsNullOrEmpty(target) || !target.StartsWith("BCDevToolset/v1/", StringComparison.Ordinal) || target.Length > 1024 || target.IndexOf('\0') >= 0)
                throw new ArgumentException("Invalid BC Dev Toolset credential target.");
        }
        public static StoredCredential Read(string target) {
            ValidateTarget(target);
            IntPtr pointer;
            if (!CredRead(target, 1, 0, out pointer)) {
                int error = Marshal.GetLastWin32Error();
                if (error == 1168) return null;
                throw new Win32Exception(error);
            }
            try {
                var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
                if (credential.CredentialBlobSize > 2560 || credential.CredentialBlobSize % 2 != 0)
                    throw new InvalidOperationException("Invalid stored credential format.");
                var password = new SecureString();
                for (int offset = 0; offset < credential.CredentialBlobSize; offset += 2)
                    password.AppendChar((char)Marshal.ReadInt16(credential.CredentialBlob, offset));
                password.MakeReadOnly();
                return new StoredCredential { UserName = credential.UserName, Password = password };
            } finally { CredFree(pointer); }
        }
        public static void Write(string target, string userName, SecureString password) {
            ValidateTarget(target);
            if (String.IsNullOrWhiteSpace(userName) || userName.Length > 513 || userName.IndexOf('\0') >= 0 || password == null || password.Length > 1280)
                throw new ArgumentException("Invalid credential username or password length.");
            IntPtr blob = Marshal.SecureStringToCoTaskMemUnicode(password);
            try {
                var credential = new Credential {
                    Type = 1, TargetName = target, UserName = userName,
                    CredentialBlobSize = (uint)(password.Length * 2), CredentialBlob = blob,
                    Persist = 2, Comment = "BC Dev Toolset"
                };
                if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
        }
        public static void Delete(string target) {
            ValidateTarget(target);
            if (!CredDelete(target, 1, 0)) {
                int error = Marshal.GetLastWin32Error();
                if (error != 1168) throw new Win32Exception(error);
            }
        }
    }
}
