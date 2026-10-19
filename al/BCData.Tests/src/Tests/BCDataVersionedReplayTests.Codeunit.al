using System.TestLibraries.Security.AccessControl;

codeunit 50218 "BCD Versioned Replay Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure TargetReadRevocationBlocksResultUntilRestored()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
    begin
        Initialize(RunId, Input, Result);
        PermissionsMock.Set('BCD EV NO TARGET R');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD Conflict Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'read') > 0, 'Replay needs current native target Read.');
        PermissionsMock.Set('BCD EV SETUP');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Restoring Read returns the original receipt.');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure TargetReadOnlyAllowsReplayButCannotApplyNewRequest()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
        Request: JsonObject;
        State: JsonObject;
        Token: JsonToken;
        ReplayInput: Text;
    begin
        Initialize(RunId, Input, Result);
        ReplayInput := Input;
        State.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        State.Get('row', Token);
        State := Token.AsObject();
        State.Get('version', Token);
        Request.ReadFrom(Input);
        Request.Replace('expectedVersion', Token.AsValue().AsText());
        Request.Replace('requestId', Format(CreateGuid(), 0, 4));
        Request.WriteTo(Input);
        PermissionsMock.Set('BCD EV TARGET R');
        Assert.AreEqual(Result, Probe.Execute(ReplayInput), 'Current Read permits historical replay without Modify.');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD Conflict Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'modify') > 0, 'A new request must still require target Modify.');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure SamePrimaryKeyReplacementCannotAuthorizeOldIdentity()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
        Target: Record "BCD Conflict Fixture";
        OriginalId: Guid;
    begin
        Initialize(RunId, Input, Result);
        Target.Get(RunId, 'ORIGINAL');
        OriginalId := Target.SystemId;
        Target.Delete();
        Commit();
        Probe.PrepareReplacement(RunRequest(RunId));
        Commit();
        Target.Get(RunId, 'ORIGINAL');
        Assert.AreNotEqual(OriginalId, Target.SystemId, 'Replacement has a distinct immutable identity.');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD_EV_REPLAY_TARGET_UNAVAILABLE');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeletedTargetDoesNotDiscloseStoredModifyResult()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
        Target: Record "BCD Conflict Fixture";
    begin
        Initialize(RunId, Input, Result);
        Target.Get(RunId, 'ORIGINAL');
        Target.Delete();
        Commit();
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD_EV_REPLAY_TARGET_UNAVAILABLE');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameReadRevocationBlocksHistoryUntilRestored()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
    begin
        InitializeOperation(RunId, Input, Result, 'rename');
        PermissionsMock.Set('BCD EV NO TARGET R');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD Conflict Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'read') > 0, 'Rename replay requires current target Read.');
        PermissionsMock.Set('BCD EV SETUP');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Restored Read recovers exact rename history.');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameReplayNeedsReadButFreshRenameNeedsModify()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
        Request: JsonObject;
        Target: Record "BCD Conflict Fixture";
        Ref: RecordRef;
        VersionField: FieldRef;
        Version: BigInteger;
    begin
        InitializeOperation(RunId, Input, Result, 'rename');
        PermissionsMock.Set('BCD EV TARGET R');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Read-only permits completed rename replay.');
        PermissionsMock.Set('BCD EV SETUP');
        // Ensure the fresh rename changes the key rather than performing a no-op.
        Target.Get(RunId, 'RENAMED');
        Target.Rename(RunId, 'ORIGINAL');
        Commit();
        Target.Get(RunId, 'ORIGINAL');
        Ref.GetTable(Target);
        VersionField := Ref.Field(0);
        Version := VersionField.Value;
        Request.ReadFrom(Input);
        Request.Replace('requestId', Format(CreateGuid(), 0, 4));
        Request.Replace('expectedVersion', Format(Version, 0, 9));
        Request.WriteTo(Input);
        PermissionsMock.Set('BCD EV TARGET R');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD Conflict Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'modify') > 0, 'Fresh rename requires native Modify.');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure InsertReadRevocationBlocksHistoryUntilRestored()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
    begin
        InitializeOperation(RunId, Input, Result, 'insert');
        PermissionsMock.Set('BCD EV NO TARGET R');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD Conflict Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'read') > 0, 'Insert replay requires current target Read.');
        PermissionsMock.Set('BCD EV SETUP');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Restored Read recovers exact insert history.');
        CheckAndClean(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure InsertReplayNeedsReadButFreshInsertNeedsInsert()
    var
        RunId: Guid;
        Input: Text;
        Result: Text;
        Request: JsonObject;
        Target: Record "BCD Conflict Fixture";
    begin
        InitializeOperation(RunId, Input, Result, 'insert');
        PermissionsMock.Set('BCD EV TARGET R');
        Assert.AreEqual(Result, Probe.Execute(Input), 'Read-only permits insert replay without target Insert.');
        PermissionsMock.Set('BCD EV SETUP');
        // Free the insertion key while preserving the original identity/history.
        Target.Get(RunId, 'ORIGINAL');
        Target.Rename(RunId, 'RENAMED');
        Commit();
        Request.ReadFrom(Input);
        Request.Replace('requestId', Format(CreateGuid(), 0, 4));
        Request.Replace('systemId', Format(CreateGuid(), 0, 4));
        Request.WriteTo(Input);
        PermissionsMock.Set('BCD EV TARGET R');
        asserterror Probe.Execute(Input);
        Assert.ExpectedError('BCD Conflict Fixture');
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'insert') > 0, 'Fresh insert requires native target Insert.');
        CheckAndClean(RunId);
    end;

    local procedure Initialize(var RunId: Guid; var Input: Text; var Result: Text)
    begin
        InitializeOperation(RunId, Input, Result, 'modify');
    end;

    local procedure InitializeOperation(var RunId: Guid; var Input: Text; var Result: Text; Operation: Text)
    var
        Row: JsonObject;
        Request: JsonObject;
        Token: JsonToken;
    begin
        if PermissionsMock.IsStarted() then
            PermissionsMock.Stop();
        PermissionsMock.Start();
        PermissionsMock.Set('BCD EV SETUP');
        RunId := CreateGuid();
        if Operation = 'insert' then
            Probe.PrepareEmpty(RunRequest(RunId))
        else
            Row.ReadFrom(Probe.Prepare(RunRequest(RunId)));
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('requestId', Format(CreateGuid(), 0, 4));
        if Operation = 'insert' then
            Request.Add('systemId', Format(CreateGuid(), 0, 4))
        else begin
            Row.Get('systemId', Token);
            Request.Add('systemId', Token.AsValue().AsText());
            Row.Get('version', Token);
            Request.Add('expectedVersion', Token.AsValue().AsText());
        end;
        Request.Add('operation', Operation);
        if Operation in ['insert', 'modify'] then
            Request.Add('amount', 4);
        Request.WriteTo(Input);
        Result := Probe.Execute(Input);
        Commit();
    end;

    local procedure CheckAndClean(RunId: Guid)
    var
        State: JsonObject;
        Token: JsonToken;
    begin
        PermissionsMock.Set('BCD EV SETUP');
        State.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        State.Get('applyCount', Token);
        Assert.AreEqual(1, Token.AsValue().AsInteger(), 'Denial does not apply a second write.');
        State.Get('receiptCount', Token);
        Assert.AreEqual(1, Token.AsValue().AsInteger(), 'The original completed receipt remains.');
        State.Get('pendingCount', Token);
        Assert.AreEqual(0, Token.AsValue().AsInteger(), 'No incomplete receipt remains.');
        Probe.Cleanup(RunRequest(RunId));
        PermissionsMock.Stop();
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    var
        Probe: Codeunit "BCD Versioned Receipt Probe";
        PermissionsMock: Codeunit "Permissions Mock";
        Assert: Codeunit "Library Assert";
}
